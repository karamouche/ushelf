package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

type fakeResult struct {
	output string
	err    error
}
type fakeCall struct {
	name   string
	args   []string
	stdout io.Writer
	stderr io.Writer
}
type fakeRunner struct {
	outputs []fakeResult
	calls   []fakeCall
}

func (f *fakeRunner) Run(_ context.Context, _ io.Reader, stdout, stderr io.Writer, name string, args ...string) error {
	f.calls = append(f.calls, fakeCall{name: name, args: append([]string(nil), args...), stdout: stdout, stderr: stderr})
	return nil
}
func (f *fakeRunner) Output(_ context.Context, name string, args ...string) (string, error) {
	f.calls = append(f.calls, fakeCall{name: name, args: append([]string(nil), args...)})
	if len(f.outputs) == 0 {
		return "", nil
	}
	result := f.outputs[0]
	f.outputs = f.outputs[1:]
	return result.output, result.err
}

func testDocker(t *testing.T, runner Runner, stdout, stderr io.Writer) Docker {
	t.Helper()
	home := t.TempDir()
	if err := atomicWrite(filepath.Join(home, "recipes", "default.md"), []byte("recipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Docker{Settings: Settings{Home: home, Host: "127.0.0.1", Port: 43110, BasePath: "/", Image: "ghcr.io/karamouche/ushelf:1.2.3", Version: "1.2.3"}, Runner: runner, Stdout: stdout, Stderr: stderr}
}

func TestStartUsesHardenedPortableMounts(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: "image"}, {output: ""}, {output: "healthy"}}}
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, runner, &stdout, &stderr)
	if err := docker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	var run fakeCall
	for _, call := range runner.calls {
		if len(call.args) > 0 && call.args[0] == "run" {
			run = call
		}
	}
	joined := strings.Join(run.args, " ")
	for _, expected := range []string{"--read-only", "no-new-privileges:true", docker.libraryDir() + ":/data/library", docker.stateDir() + ":/data/state", docker.secretsDir() + ":/data/secrets:ro", "USHELF_STATE_DIR=/data/state", "USHELF_SECRETS_DIR=/data/secrets", "127.0.0.1:43110:43110"} {
		if !strings.Contains(joined, expected) {
			t.Errorf("docker run missing %q: %s", expected, joined)
		}
	}
}

func TestStopRefusesUnmanagedContainer(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: "ushelf"}, {output: "false"}}}
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, runner, &stdout, &stderr)
	err := docker.Stop(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not managed") {
		t.Fatalf("expected ownership error, got %v", err)
	}
	for _, call := range runner.calls {
		if len(call.args) > 0 && call.args[0] == "rm" {
			t.Fatal("unmanaged container was removed")
		}
	}
}

func TestMCPKeepsDiagnosticsOffStdout(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{err: errors.New("missing")}}}
	var protocol, diagnostics bytes.Buffer
	docker := testDocker(t, runner, &protocol, &diagnostics)
	if err := docker.MCP(context.Background()); err != nil {
		t.Fatal(err)
	}
	if protocol.Len() != 0 {
		t.Fatalf("protocol stdout was polluted: %q", protocol.String())
	}
	if !strings.Contains(diagnostics.String(), "Pulling") {
		t.Fatalf("missing pull diagnostic: %q", diagnostics.String())
	}
	last := runner.calls[len(runner.calls)-1]
	if last.stdout != &protocol || last.stderr != &diagnostics {
		t.Fatal("MCP streams were not passed through")
	}
	if !strings.Contains(strings.Join(last.args, " "), "apps/mcp/dist/index.js") {
		t.Fatal("MCP entrypoint missing")
	}
	if strings.Contains(strings.Join(last.args, " "), "/data/secrets") {
		t.Fatal("MCP container received Kindle secrets")
	}
}

func TestStatusIncludesVersionAndHome(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: ""}}}
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, runner, &stdout, &stderr)
	if err := docker.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"Status: stopped", "Version: 1.2.3", "Home: " + docker.Settings.Home} {
		if !strings.Contains(stdout.String(), expected) {
			t.Fatalf("status missing %q: %s", expected, stdout.String())
		}
	}
}

func TestStatusPropagatesDockerListFailure(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{err: errors.New("daemon unavailable")}}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	err := docker.Status(context.Background())
	if err == nil || !strings.Contains(err.Error(), "daemon unavailable") {
		t.Fatalf("expected Docker daemon error, got %v", err)
	}
}

func TestIsRunningPropagatesStateInspectionFailure(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{
		{output: "ushelf"},
		{output: "true"},
		{err: errors.New("inspect failed")},
	}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	running, err := docker.IsRunning(context.Background())
	if err == nil || !strings.Contains(err.Error(), "inspect failed") {
		t.Fatalf("expected inspection error, got running=%t err=%v", running, err)
	}
}

func TestCheckManagedHealthPropagatesInspectionFailure(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{
		{output: "ushelf"},
		{output: "true"},
		{err: errors.New("health inspect failed")},
	}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	err := docker.CheckManagedHealth(context.Background())
	if err == nil || !strings.Contains(err.Error(), "health inspect failed") {
		t.Fatalf("expected health inspection error, got %v", err)
	}
}
