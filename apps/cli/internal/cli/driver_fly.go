package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	flyVolumeName   = "ushelf_data"
	flyVolumeSizeGB = "1"
)

// FlyDeployment runs the server as a single Fly.io Machine with a persistent volume.
// Fly terminates TLS, so the reader, API, and MCP endpoint are served over HTTPS.
type FlyDeployment struct {
	Context Context
	Runner  Runner
	Stdout  io.Writer
	Stderr  io.Writer
	Actions *actionReporter
}

func (f FlyDeployment) app() string { return f.Context.Spec.App }

func (f FlyDeployment) runQuiet(ctx context.Context, stdin io.Reader, args ...string) error {
	var output bytes.Buffer
	if err := f.Runner.Run(ctx, stdin, &output, &output, "fly", args...); err != nil {
		if detail := strings.TrimSpace(output.String()); detail != "" {
			return fmt.Errorf("%w: %s", err, detail)
		}
		return err
	}
	return nil
}

func (f FlyDeployment) Apply(ctx context.Context) error {
	f.Actions.Step("Checking the Fly.io app %s...", f.app())
	if _, err := f.Runner.Output(ctx, "fly", "status", "--app", f.app(), "--json"); err != nil {
		f.Actions.Step("Creating the Fly.io app %s...", f.app())
		args := []string{"apps", "create", f.app(), "--yes"}
		if f.Context.Spec.Org != "" {
			args = append(args, "--org", f.Context.Spec.Org)
		}
		if err := f.runQuiet(ctx, nil, args...); err != nil {
			return fmt.Errorf("create Fly.io app: %w", err)
		}
	}
	if err := f.ensureVolume(ctx); err != nil {
		return err
	}
	f.Actions.Step("Storing uShelf secrets in Fly.io...")
	secrets := "USHELF_API_TOKEN=" + f.Context.Credentials.APIToken + "\n" +
		"USHELF_APP_PASSWORD=" + f.Context.Credentials.AppPassword + "\n"
	if err := f.runQuiet(ctx, strings.NewReader(secrets), "secrets", "import", "--app", f.app(), "--stage"); err != nil {
		return fmt.Errorf("store Fly.io secrets: %w", err)
	}

	directory, err := os.MkdirTemp(f.Context.Home, ".fly-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	configPath := filepath.Join(directory, "fly.toml")
	if err := os.WriteFile(configPath, []byte(f.flyConfig()), 0o600); err != nil {
		return err
	}
	f.Actions.Step("Deploying %s to Fly.io...", f.Context.Image())
	if err := f.Runner.Run(ctx, nil, f.Stderr, f.Stderr, "fly", "deploy", "--app", f.app(), "--config", configPath,
		"--image", f.Context.Image(), "--ha=false", "--yes"); err != nil {
		return fmt.Errorf("deploy to Fly.io: %w", err)
	}
	machines, err := f.machines(ctx)
	if err != nil {
		return err
	}
	if len(machines) == 0 {
		f.Actions.Step("Starting a Fly.io Machine...")
		return f.runQuiet(ctx, nil, "scale", "count", "1", "--app", f.app(), "--region", f.Context.Spec.Region, "--yes")
	}
	return nil
}

func (f FlyDeployment) ensureVolume(ctx context.Context) error {
	raw, err := f.Runner.Output(ctx, "fly", "volumes", "list", "--app", f.app(), "--json")
	if err != nil {
		return fmt.Errorf("list Fly.io volumes: %w", err)
	}
	var volumes []struct {
		Name  string `json:"name"`
		State string `json:"state"`
	}
	if err := json.Unmarshal([]byte(raw), &volumes); err != nil {
		return fmt.Errorf("parse Fly.io volumes: %w", err)
	}
	for _, volume := range volumes {
		if volume.Name == flyVolumeName && !strings.Contains(volume.State, "destroy") {
			return nil
		}
	}
	f.Actions.Step("Creating the %s volume in %s...", flyVolumeName, f.Context.Spec.Region)
	if err := f.runQuiet(ctx, nil, "volumes", "create", flyVolumeName, "--app", f.app(), "--region", f.Context.Spec.Region,
		"--size", flyVolumeSizeGB, "--yes"); err != nil {
		return fmt.Errorf("create Fly.io volume: %w", err)
	}
	return nil
}

// flyConfig keeps one Machine because Markdown and SQLite live on a single volume.
func (f FlyDeployment) flyConfig() string {
	return fmt.Sprintf(`app = %q
primary_region = %q

[env]
  NODE_ENV = "production"
  USHELF_HOST = "0.0.0.0"
  USHELF_PORT = "%d"
  USHELF_ROOT = "/data"
  USHELF_WEB_BASE_PATH = %q

[[mounts]]
  source = %q
  destination = "/data"

[http_service]
  internal_port = %d
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    grace_period = "15s"
    interval = "30s"
    method = "GET"
    timeout = "5s"
    path = "%sapi/health"

[[vm]]
  memory = "1gb"
`, f.app(), f.Context.Spec.Region, f.Context.Port(), f.Context.BasePath(), flyVolumeName, f.Context.Port(), f.Context.BasePath())
}

type flyMachine struct {
	State string `json:"state"`
}

func (f FlyDeployment) machines(ctx context.Context) ([]flyMachine, error) {
	raw, err := f.Runner.Output(ctx, "fly", "status", "--app", f.app(), "--json")
	if err != nil {
		return nil, fmt.Errorf("read Fly.io status: %w", err)
	}
	var status struct {
		Machines []flyMachine `json:"machines"`
	}
	if err := json.Unmarshal([]byte(raw), &status); err != nil {
		return nil, fmt.Errorf("parse Fly.io status: %w", err)
	}
	return status.Machines, nil
}

func (f FlyDeployment) Stop(ctx context.Context) error {
	f.Actions.Step("Scaling %s to zero Machines...", f.app())
	if err := f.runQuiet(ctx, nil, "scale", "count", "0", "--app", f.app(), "--yes"); err != nil {
		return err
	}
	f.Actions.Done("uShelf stopped on Fly.io; the %s volume and your library are unchanged", flyVolumeName)
	return nil
}

func (f FlyDeployment) State(ctx context.Context) (string, error) {
	machines, err := f.machines(ctx)
	if err != nil {
		return "", err
	}
	if len(machines) == 0 {
		return "stopped", nil
	}
	states := make([]string, 0, len(machines))
	for _, machine := range machines {
		if machine.State == "started" {
			return "running", nil
		}
		states = append(states, machine.State)
	}
	return strings.Join(states, ", "), nil
}

func (f FlyDeployment) Logs(ctx context.Context, follow bool, _ int) error {
	args := []string{"logs", "--app", f.app()}
	if !follow {
		args = append(args, "--no-tail")
	}
	return f.Runner.Run(ctx, nil, f.Stdout, f.Stderr, "fly", args...)
}

func (f FlyDeployment) Diagnose(ctx context.Context, check func(string, error)) {
	_, err := f.Runner.Output(ctx, "fly", "version")
	check("flyctl", err)
	_, err = f.Runner.Output(ctx, "fly", "auth", "whoami")
	check("fly login", err)
}
