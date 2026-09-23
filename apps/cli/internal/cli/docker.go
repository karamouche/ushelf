package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const containerName = "ushelf"

var (
	healthTimeout      = 45 * time.Second
	healthPollInterval = 500 * time.Millisecond
)

type Docker struct {
	Settings Settings
	Runner   Runner
	Stdin    io.Reader
	Stdout   io.Writer
	Stderr   io.Writer
	Actions  *actionReporter
}

func (d Docker) EnsureDirectories() error {
	for _, path := range []string{d.libraryDir(), d.itemsDir(), d.historyDir(), d.recipesDir(), d.stateDir(), d.assetsDir(), d.secretsDir()} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
	}
	return nil
}

func (d Docker) EnsureImage(ctx context.Context) error {
	if _, err := d.Runner.Output(ctx, "docker", "image", "inspect", d.Settings.Image); err == nil {
		return nil
	}
	d.step("Downloading runtime image %s...", d.Settings.Image)
	return d.runQuiet(ctx, "docker", "pull", d.Settings.Image)
}

func (d Docker) SeedRecipe(ctx context.Context) error {
	target := filepath.Join(d.recipesDir(), "default.md")
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	d.step("Installing the default enrichment recipe...")
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	contents, err := d.Runner.Output(ctx, "docker", "run", "--rm", "--entrypoint", "cat", d.Settings.Image, "/opt/ushelf/recipes/default.md")
	if err != nil {
		return fmt.Errorf("read default recipe from image: %w", err)
	}
	return atomicWrite(target, []byte(contents), 0o600)
}

func (d Docker) Start(ctx context.Context) error {
	d.step("Preparing the uShelf home at %s...", d.Settings.Home)
	if err := d.EnsureDirectories(); err != nil {
		return err
	}
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	if err := d.SeedRecipe(ctx); err != nil {
		return err
	}
	exists, err := d.managedContainerExists(ctx)
	if err != nil {
		return err
	}
	hash := d.configHash()
	if exists {
		existingHash, inspectErr := d.inspect(ctx, `{{index .Config.Labels "io.ushelf.config"}}`)
		if inspectErr != nil {
			return inspectErr
		}
		if strings.TrimSpace(existingHash) == hash {
			running, runningErr := d.inspect(ctx, "{{.State.Running}}")
			if runningErr != nil {
				return runningErr
			}
			if strings.TrimSpace(running) != "true" {
				d.step("Starting the existing uShelf service...")
				if err := d.runQuiet(ctx, "docker", "start", containerName); err != nil {
					return err
				}
			} else {
				d.step("Checking the running uShelf service...")
			}
			if err := d.waitForHealth(ctx); err != nil {
				return err
			}
			d.done("uShelf is ready at %s", d.Settings.LocalURL())
			return nil
		}
		d.step("Recreating the uShelf service for the current configuration...")
		if err := d.runQuiet(ctx, "docker", "rm", "-f", containerName); err != nil {
			return err
		}
	} else {
		d.step("Creating the uShelf service...")
	}
	args := []string{"run", "-d", "--name", containerName,
		"--label", "io.ushelf.managed=true", "--label", "io.ushelf.config=" + hash,
		"--init", "--restart", "unless-stopped", "--read-only", "--tmpfs", "/tmp",
		"--security-opt", "no-new-privileges:true", "--user", currentUser(),
		"-e", "NODE_ENV=production", "-e", "USHELF_ROOT=/data",
		"-e", "USHELF_KINDLE_BRIDGE=/app/bin/ushelf-kindle-bridge",
		"-e", "USHELF_HOST=0.0.0.0", "-e", "USHELF_PORT=" + strconv.Itoa(d.Settings.Port),
		"-e", "USHELF_WEB_BASE_PATH=" + d.Settings.BasePath,
		"-p", fmt.Sprintf("%s:%d", net.JoinHostPort(d.publishHost(), strconv.Itoa(d.Settings.Port)), d.Settings.Port),
		"-v", d.libraryDir() + ":/data/library", "-v", d.recipesDir() + ":/data/recipes:ro",
		"-v", d.stateDir() + ":/data/state", "-v", d.secretsDir() + ":/data/secrets:ro", d.Settings.Image}
	if err := d.runQuiet(ctx, "docker", args...); err != nil {
		return err
	}
	if err := d.waitForHealth(ctx); err != nil {
		return err
	}
	d.done("uShelf is ready at %s", d.Settings.LocalURL())
	return nil
}

func (d Docker) Stop(ctx context.Context) error {
	exists, err := d.managedContainerExists(ctx)
	if err != nil {
		return err
	}
	if !exists {
		d.done("uShelf is already stopped")
		return nil
	}
	d.step("Stopping the uShelf service...")
	if err := d.runQuiet(ctx, "docker", "rm", "-f", containerName); err != nil {
		return err
	}
	d.done("uShelf stopped; your library is unchanged")
	return nil
}

func (d Docker) IsRunning(ctx context.Context) (bool, error) {
	exists, err := d.managedContainerExists(ctx)
	if err != nil || !exists {
		return false, err
	}
	value, err := d.inspect(ctx, "{{.State.Running}}")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(value) == "true", nil
}

func (d Docker) Status(ctx context.Context) error {
	exists, ownershipErr := d.managedContainerExists(ctx)
	if ownershipErr != nil {
		return ownershipErr
	}
	if !exists {
		fmt.Fprintf(d.Stdout, "Status: stopped\nHealth: unavailable\nURL: %s\nVersion: %s\nImage: %s\nHome: %s\n", d.Settings.LocalURL(), d.Settings.Version, d.Settings.Image, d.Settings.Home)
		return nil
	}
	value, err := d.inspect(ctx, "{{json .State}}")
	if err != nil {
		return err
	}
	var state struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(value)), &state); err != nil {
		return fmt.Errorf("parse Docker status: %w", err)
	}
	health := "unavailable"
	if state.Health != nil {
		health = state.Health.Status
	}
	fmt.Fprintf(d.Stdout, "Status: %s\nHealth: %s\nURL: %s\nVersion: %s\nImage: %s\nHome: %s\n", state.Status, health, d.Settings.LocalURL(), d.Settings.Version, d.Settings.Image, d.Settings.Home)
	return nil
}

func (d Docker) Logs(ctx context.Context, follow bool, tail int) error {
	exists, err := d.managedContainerExists(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("uShelf is not running")
	}
	args := []string{"logs", "--tail", strconv.Itoa(tail)}
	if follow {
		args = append(args, "--follow")
	}
	args = append(args, containerName)
	return d.Runner.Run(ctx, nil, d.Stdout, d.Stderr, "docker", args...)
}

func (d Docker) MCP(ctx context.Context) error {
	if err := d.EnsureDirectories(); err != nil {
		return err
	}
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	if err := d.SeedRecipe(ctx); err != nil {
		return err
	}
	args := append(d.oneShotArgs(), "-i",
		"-e", "USHELF_KINDLE_BRIDGE=/app/bin/ushelf-kindle-bridge",
		"-v", d.secretsDir()+":/data/secrets:ro",
		d.Settings.Image, "node", "apps/mcp/dist/index.js")
	return d.Runner.Run(ctx, d.Stdin, d.Stdout, d.Stderr, "docker", args...)
}

func (d Docker) Maintenance(ctx context.Context, args ...string) error {
	if err := d.EnsureDirectories(); err != nil {
		return err
	}
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	if err := d.SeedRecipe(ctx); err != nil {
		return err
	}
	command := append(d.oneShotArgs(), d.Settings.Image, "node", "apps/server/dist/cli.js")
	command = append(command, args...)
	d.step("Running index maintenance...")
	if err := d.withServiceStopped(ctx, func() error {
		return d.Runner.Run(ctx, nil, d.Stdout, d.Stderr, "docker", command...)
	}); err != nil {
		return err
	}
	d.done("Index rebuild completed")
	return nil
}

func (d Docker) Import(ctx context.Context, source string) error {
	abs, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return fmt.Errorf("read import file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("import path must be a regular file")
	}
	if err := d.EnsureDirectories(); err != nil {
		return err
	}
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	if err := d.SeedRecipe(ctx); err != nil {
		return err
	}
	args := append(d.oneShotArgs(), "-v", abs+":/import/item.md:ro", d.Settings.Image, "node", "apps/server/dist/cli.js", "import", "/import/item.md")
	d.step("Importing %s...", abs)
	if err := d.withServiceStopped(ctx, func() error {
		return d.Runner.Run(ctx, nil, d.Stdout, d.Stderr, "docker", args...)
	}); err != nil {
		return err
	}
	d.done("Markdown item imported")
	return nil
}

func (d Docker) withServiceStopped(ctx context.Context, operation func() error) error {
	if _, err := d.managedContainerExists(ctx); err != nil {
		return err
	}
	wasRunning, err := d.IsRunning(ctx)
	if err != nil {
		return err
	}
	if wasRunning {
		d.step("Pausing the uShelf service...")
		if err := d.runQuiet(ctx, "docker", "stop", containerName); err != nil {
			return err
		}
	}
	operationErr := operation()
	if !wasRunning {
		return operationErr
	}
	d.step("Restoring the uShelf service...")
	restartErr := d.runQuiet(context.Background(), "docker", "start", containerName)
	return errors.Join(operationErr, restartErr)
}

func (d Docker) oneShotArgs() []string {
	return []string{"run", "--rm", "--init", "--read-only", "--tmpfs", "/tmp", "--security-opt", "no-new-privileges:true",
		"--user", currentUser(), "-e", "NODE_ENV=production", "-e", "USHELF_ROOT=/data",
		"-v", d.libraryDir() + ":/data/library", "-v", d.recipesDir() + ":/data/recipes:ro", "-v", d.stateDir() + ":/data/state"}
}

func (d Docker) waitForHealth(ctx context.Context) error {
	d.step("Waiting for uShelf to become ready...")
	deadline := time.Now().Add(healthTimeout)
	for time.Now().Before(deadline) {
		status, err := d.inspect(ctx, "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}")
		if err == nil {
			switch strings.TrimSpace(status) {
			case "healthy", "running":
				return nil
			case "unhealthy", "exited", "dead":
				return d.startupFailure(ctx, fmt.Errorf("uShelf container became %s", strings.TrimSpace(status)))
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(healthPollInterval):
		}
	}
	return d.startupFailure(ctx, errors.New("timed out waiting for uShelf health check"))
}

func (d Docker) startupFailure(ctx context.Context, cause error) error {
	var message strings.Builder
	message.WriteString(cause.Error())
	if logs, err := d.recentLogs(ctx, 20); err == nil && strings.TrimSpace(logs) != "" {
		message.WriteString("\n\nRecent service logs:\n")
		for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
			fmt.Fprintf(&message, "  %s\n", line)
		}
	}
	message.WriteString("\nNext steps:\n  ushelf logs --tail 200\n  ushelf doctor")
	return errors.New(message.String())
}

func (d Docker) recentLogs(ctx context.Context, tail int) (string, error) {
	var output bytes.Buffer
	err := d.Runner.Run(ctx, nil, &output, &output, "docker", "logs", "--tail", strconv.Itoa(tail), containerName)
	return output.String(), err
}

func (d Docker) runQuiet(ctx context.Context, name string, args ...string) error {
	var output bytes.Buffer
	if err := d.Runner.Run(ctx, nil, &output, &output, name, args...); err != nil {
		if detail := strings.TrimSpace(output.String()); detail != "" {
			return fmt.Errorf("%w: %s", err, detail)
		}
		return err
	}
	return nil
}

func (d Docker) step(format string, args ...any) {
	if d.Actions != nil {
		d.Actions.Step(format, args...)
		return
	}
	if d.Stderr != nil {
		fmt.Fprintf(d.Stderr, "==> "+format+"\n", args...)
	}
}

func (d Docker) done(format string, args ...any) {
	if d.Actions != nil {
		d.Actions.Done(format, args...)
		return
	}
	fmt.Fprintf(d.Stdout, format+"\n", args...)
}

func (d Docker) inspect(ctx context.Context, format string) (string, error) {
	return d.Runner.Output(ctx, "docker", "inspect", "--format", format, containerName)
}

func (d Docker) managedContainerExists(ctx context.Context) (bool, error) {
	names, err := d.Runner.Output(ctx, "docker", "container", "ls", "--all", "--filter", "name="+containerName, "--format", "{{.Names}}")
	if err != nil {
		return false, fmt.Errorf("list Docker containers: %w", err)
	}
	exists := false
	for _, name := range strings.Fields(names) {
		if name == containerName {
			exists = true
			break
		}
	}
	if !exists {
		return false, nil
	}
	managed, err := d.inspect(ctx, `{{index .Config.Labels "io.ushelf.managed"}}`)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(managed) != "true" {
		return true, fmt.Errorf("Docker container %q exists but is not managed by the uShelf CLI", containerName)
	}
	return true, nil
}

func (d Docker) configHash() string {
	value := strings.Join([]string{d.Settings.Image, d.Settings.Home, d.Settings.Host, strconv.Itoa(d.Settings.Port), d.Settings.BasePath}, "\x00")
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (d Docker) CheckPort() error {
	running, err := d.IsRunning(context.Background())
	if err != nil {
		return err
	}
	if running {
		return nil
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(d.Settings.Host, strconv.Itoa(d.Settings.Port)))
	if err != nil {
		return err
	}
	return listener.Close()
}

func (d Docker) CheckWritable() error {
	for _, directory := range []string{d.libraryDir(), d.recipesDir(), d.stateDir()} {
		file, err := os.CreateTemp(directory, ".ushelf-write-check-*")
		if err != nil {
			return fmt.Errorf("%s is not writable: %w", directory, err)
		}
		name := file.Name()
		if err := file.Close(); err != nil {
			return err
		}
		if err := os.Remove(name); err != nil {
			return err
		}
	}
	return nil
}

func (d Docker) CheckImageArchitecture(ctx context.Context) error {
	architecture, err := d.Runner.Output(ctx, "docker", "image", "inspect", "--format", "{{.Architecture}}", d.Settings.Image)
	if err != nil {
		return err
	}
	if strings.TrimSpace(architecture) != runtime.GOARCH {
		return fmt.Errorf("image architecture is %s, CLI architecture is %s", strings.TrimSpace(architecture), runtime.GOARCH)
	}
	return nil
}

func (d Docker) CheckManagedHealth(ctx context.Context) error {
	exists, ownershipErr := d.managedContainerExists(ctx)
	if ownershipErr != nil {
		return ownershipErr
	}
	if !exists {
		return nil
	}
	status, err := d.inspect(ctx, "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}")
	if err != nil {
		return err
	}
	value := strings.TrimSpace(status)
	if value != "healthy" && value != "running" {
		return fmt.Errorf("managed container is %s", value)
	}
	return nil
}

func (d Docker) libraryDir() string { return filepath.Join(d.Settings.Home, "library") }
func (d Docker) itemsDir() string   { return filepath.Join(d.libraryDir(), "items") }
func (d Docker) historyDir() string { return filepath.Join(d.libraryDir(), "history") }
func (d Docker) recipesDir() string { return filepath.Join(d.Settings.Home, "recipes") }
func (d Docker) stateDir() string   { return filepath.Join(d.Settings.Home, "state") }
func (d Docker) assetsDir() string  { return filepath.Join(d.Settings.Home, "assets") }
func (d Docker) secretsDir() string { return filepath.Join(d.Settings.Home, "secrets") }

func (d Docker) publishHost() string {
	if d.Settings.Host == "localhost" {
		return "127.0.0.1"
	}
	return d.Settings.Host
}

func currentUser() string {
	if runtime.GOOS == "windows" {
		return "1000:1000"
	}
	return fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
}

func atomicWrite(path string, contents []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, contents, mode); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
