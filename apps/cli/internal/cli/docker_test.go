package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeResult struct {
	output string
	err    error
}
type fakeRunResult struct {
	stdout string
	stderr string
	err    error
}
type fakeCall struct {
	name   string
	args   []string
	stdout io.Writer
	stderr io.Writer
}
type fakeRunner struct {
	outputs    []fakeResult
	runResults []fakeRunResult
	calls      []fakeCall
}

func (f *fakeRunner) Run(_ context.Context, _ io.Reader, stdout, stderr io.Writer, name string, args ...string) error {
	f.calls = append(f.calls, fakeCall{name: name, args: append([]string(nil), args...), stdout: stdout, stderr: stderr})
	if len(f.runResults) == 0 {
		return nil
	}
	result := f.runResults[0]
	f.runResults = f.runResults[1:]
	if stdout != nil {
		_, _ = io.WriteString(stdout, result.stdout)
	}
	if stderr != nil {
		_, _ = io.WriteString(stderr, result.stderr)
	}
	return result.err
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
	return Docker{
		Settings: Settings{Home: home, Host: "127.0.0.1", Port: 43110, BasePath: "/", Image: "ghcr.io/karamouche/ushelf:1.2.3", Version: "1.2.3"},
		Runner:   runner,
		Stdout:   stdout,
		Stderr:   stderr,
		Actions:  newActionReporter(stderr, stdout),
	}
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
	for _, expected := range []string{"--read-only", "no-new-privileges:true", docker.libraryDir() + ":/data/library", docker.stateDir() + ":/data/state", docker.secretsDir() + ":/data/secrets:ro", "USHELF_ROOT=/data", "127.0.0.1:43110:43110"} {
		if !strings.Contains(joined, expected) {
			t.Errorf("docker run missing %q: %s", expected, joined)
		}
	}
	for _, redundant := range []string{"USHELF_STATE_DIR", "USHELF_SECRETS_DIR"} {
		if strings.Contains(joined, redundant) {
			t.Errorf("docker run should derive %s from USHELF_ROOT: %s", redundant, joined)
		}
	}
}

func TestStartPassesWebPasswordWithoutPuttingItsValueInArguments(t *testing.T) {
	t.Setenv("USHELF_WEB_PASSWORD", "a-secret-with-spaces")
	runner := &fakeRunner{outputs: []fakeResult{{output: "image"}, {output: ""}, {output: "healthy"}}}
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, runner, &stdout, &stderr)
	withPassword := docker.configHash()
	if err := docker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, call := range runner.calls {
		if len(call.args) == 0 || call.args[0] != "run" {
			continue
		}
		joined := strings.Join(call.args, " ")
		if !strings.Contains(joined, "-e USHELF_WEB_PASSWORD") || strings.Contains(joined, "a-secret-with-spaces") {
			t.Fatalf("password environment was not passed safely: %s", joined)
		}
	}
	t.Setenv("USHELF_WEB_PASSWORD", "different-secret")
	if withPassword == docker.configHash() {
		t.Fatal("password change should recreate the managed container")
	}
	t.Setenv("USHELF_WEB_PASSWORD", "")
	if withPassword == docker.configHash() {
		t.Fatal("removing the password should change the managed container configuration")
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
	if !strings.Contains(diagnostics.String(), "Downloading runtime image") {
		t.Fatalf("missing pull diagnostic: %q", diagnostics.String())
	}
	last := runner.calls[len(runner.calls)-1]
	if last.stdout != &protocol || last.stderr != &diagnostics {
		t.Fatal("MCP streams were not passed through")
	}
	if !strings.Contains(strings.Join(last.args, " "), "apps/mcp/dist/index.js") {
		t.Fatal("MCP entrypoint missing")
	}
	joined := strings.Join(last.args, " ")
	for _, expected := range []string{docker.secretsDir() + ":/data/secrets:ro", "USHELF_ROOT=/data", "USHELF_KINDLE_BRIDGE=/app/bin/ushelf-kindle-bridge"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("MCP container missing %q: %s", expected, joined)
		}
	}
	if strings.Contains(joined, "USHELF_SECRETS_DIR") {
		t.Fatalf("MCP container should derive USHELF_SECRETS_DIR from USHELF_ROOT: %s", joined)
	}
}

func TestStartReportsProgressWithoutRawContainerID(t *testing.T) {
	runner := &fakeRunner{
		outputs:    []fakeResult{{output: "image"}, {output: ""}, {output: "healthy"}},
		runResults: []fakeRunResult{{stdout: "6b88fef57f44\n"}},
	}
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, runner, &stdout, &stderr)
	if err := docker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stdout.String(), "6b88fef57f44") {
		t.Fatalf("raw container ID leaked to stdout: %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), "Done: uShelf is ready at http://127.0.0.1:43110/") {
		t.Fatalf("missing completion result: %q", stdout.String())
	}
	for _, expected := range []string{"Preparing the uShelf home", "Creating the uShelf service", "Waiting for uShelf to become ready"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Fatalf("missing progress %q: %q", expected, stderr.String())
		}
	}
}

func TestStartReportsExistingContainerState(t *testing.T) {
	for _, test := range []struct {
		name     string
		running  string
		progress string
		runCount int
	}{
		{name: "stopped", running: "false", progress: "Starting the existing uShelf service", runCount: 1},
		{name: "running", running: "true", progress: "Checking the running uShelf service", runCount: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			docker := testDocker(t, &fakeRunner{}, &stdout, &stderr)
			runner := &fakeRunner{outputs: []fakeResult{
				{output: "image"},
				{output: containerName},
				{output: "true"},
				{output: docker.configHash()},
				{output: test.running},
				{output: "healthy"},
			}}
			docker.Runner = runner
			if err := docker.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(stderr.String(), test.progress) {
				t.Fatalf("missing state-specific progress %q: %q", test.progress, stderr.String())
			}
			if len(runner.runResults) != 0 || countRunCalls(runner.calls) != test.runCount {
				t.Fatalf("unexpected subprocess calls: %#v", runner.calls)
			}
		})
	}
}

func TestStartReportsConfigurationReconciliation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, &fakeRunner{}, &stdout, &stderr)
	runner := &fakeRunner{
		outputs: []fakeResult{
			{output: "image"},
			{output: containerName},
			{output: "true"},
			{output: "outdated-config-hash"},
			{output: "healthy"},
		},
		runResults: []fakeRunResult{{stdout: containerName + "\n"}, {stdout: "6b88fef57f44\n"}},
	}
	docker.Runner = runner
	if err := docker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "Recreating the uShelf service for the current configuration") {
		t.Fatalf("missing reconciliation progress: %q", stderr.String())
	}
	if strings.Contains(stdout.String(), containerName) || strings.Contains(stdout.String(), "6b88fef57f44") {
		t.Fatalf("raw Docker output leaked: %q", stdout.String())
	}
}

func TestStartFailureIncludesRecentLogsAndNextSteps(t *testing.T) {
	runner := &fakeRunner{
		outputs: []fakeResult{{output: "image"}, {output: ""}, {output: "unhealthy"}},
		runResults: []fakeRunResult{
			{},
			{stdout: "database migration failed\n", stderr: "permission denied\n"},
		},
	}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	err := docker.Start(context.Background())
	if err == nil {
		t.Fatal("expected unhealthy startup to fail")
	}
	for _, expected := range []string{"Recent service logs:", "database migration failed", "permission denied", "ushelf logs --tail 200", "ushelf doctor"} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("startup error missing %q: %v", expected, err)
		}
	}
}

func TestStartCancellationDoesNotDumpLogs(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: "image"}, {output: ""}, {output: "starting"}}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := docker.Start(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if strings.Contains(err.Error(), "Recent service logs") || strings.Contains(err.Error(), "Next steps") {
		t.Fatalf("cancellation included startup diagnostics: %v", err)
	}
}

func TestStartTimeoutIncludesNextStepsWhenLogsUnavailable(t *testing.T) {
	previousTimeout, previousInterval := healthTimeout, healthPollInterval
	healthTimeout, healthPollInterval = time.Millisecond, time.Millisecond
	t.Cleanup(func() {
		healthTimeout, healthPollInterval = previousTimeout, previousInterval
	})
	runner := &fakeRunner{
		outputs:    []fakeResult{{output: "image"}, {output: ""}, {output: "starting"}},
		runResults: []fakeRunResult{{}, {err: errors.New("logs unavailable")}},
	}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	err := docker.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "timed out") || !strings.Contains(err.Error(), "ushelf doctor") {
		t.Fatalf("unexpected timeout error: %v", err)
	}
	if strings.Contains(err.Error(), "Recent service logs") {
		t.Fatalf("unavailable logs should be omitted: %v", err)
	}
}

func TestMaintenanceDoesNotReceiveKindleSecrets(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: ""}}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	if err := docker.Maintenance(context.Background(), "rebuild-index"); err != nil {
		t.Fatal(err)
	}
	last := runner.calls[len(runner.calls)-1]
	joined := strings.Join(last.args, " ")
	if strings.Contains(joined, "/data/secrets") || strings.Contains(joined, "USHELF_KINDLE_BRIDGE") {
		t.Fatalf("maintenance container received Kindle access: %s", joined)
	}
}

func TestMaintenanceSeedsRecipeBeforeReadOnlyContainer(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: "image"}, {output: "image"}, {output: "seeded recipe"}}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	recipePath := filepath.Join(docker.recipesDir(), "default.md")
	if err := os.Remove(recipePath); err != nil {
		t.Fatal(err)
	}

	if err := docker.Maintenance(context.Background(), "rebuild-index"); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(recipePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "seeded recipe" {
		t.Fatalf("recipe = %q", contents)
	}
}

func TestImportSeedsRecipeBeforeReadOnlyContainer(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: "image"}, {output: "image"}, {output: "seeded recipe"}}}
	docker := testDocker(t, runner, &bytes.Buffer{}, &bytes.Buffer{})
	recipePath := filepath.Join(docker.recipesDir(), "default.md")
	if err := os.Remove(recipePath); err != nil {
		t.Fatal(err)
	}
	importPath := filepath.Join(t.TempDir(), "item.md")
	if err := os.WriteFile(importPath, []byte("item"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := docker.Import(context.Background(), importPath); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(recipePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "seeded recipe" {
		t.Fatalf("recipe = %q", contents)
	}
}

func TestMaintenanceReportsRestartFailure(t *testing.T) {
	runner := &fakeRunner{
		outputs: []fakeResult{
			{output: "image"},
			{output: containerName}, {output: "true"},
			{output: containerName}, {output: "true"}, {output: "true"},
		},
		runResults: []fakeRunResult{
			{},
			{},
			{stderr: "Docker could not restart the service", err: errors.New("restart failed")},
		},
	}
	var stdout, stderr bytes.Buffer
	docker := testDocker(t, runner, &stdout, &stderr)
	err := docker.Maintenance(context.Background(), "rebuild-index")
	if err == nil || !strings.Contains(err.Error(), "restart failed") || !strings.Contains(err.Error(), "Docker could not restart") {
		t.Fatalf("expected restart failure details, got %v", err)
	}
	if strings.Contains(stdout.String(), "Done:") {
		t.Fatalf("failed maintenance reported success: %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "Restoring the uShelf service") {
		t.Fatalf("missing restore progress: %q", stderr.String())
	}
}

func countRunCalls(calls []fakeCall) int {
	count := 0
	for _, call := range calls {
		if call.stdout != nil || call.stderr != nil {
			count++
		}
	}
	return count
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
