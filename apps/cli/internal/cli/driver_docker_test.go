package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "test-api-token-0123456789abcdefghijklmnop"

func testDeployment(t *testing.T, runner Runner, spec ContextSpec, credentials Credentials) (DockerDeployment, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	home := t.TempDir()
	if err := atomicWrite(filepath.Join(home, "recipes", "default.md"), []byte("recipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	return DockerDeployment{
		Context: Context{Name: "test", Spec: spec, Credentials: credentials, Home: home, Version: "1.2.3"},
		Runner:  runner, Stdout: &stdout, Stderr: &stderr, Actions: newActionReporter(&stderr, &stdout),
	}, &stdout, &stderr
}

func runCalls(runner *scriptRunner, name string) []fakeCall {
	return runner.find(func(call fakeCall) bool {
		args := dockerArgs(call)
		return hasPrefix(args, "run", "-d") && strings.Contains(call.joined(), "--name "+name+" ")
	})
}

func TestLocalApplyUsesHardenedMountsAndKeepsSecretsOffTheCommandLine(t *testing.T) {
	runner := &scriptRunner{handler: freshDocker}
	deployment, _, stderr := testDeployment(t, runner, ContextSpec{Driver: DriverLocal},
		Credentials{APIToken: testToken, AppPassword: "a secret with spaces"})
	if err := deployment.Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	runs := runCalls(runner, containerName)
	if len(runs) != 1 {
		t.Fatalf("expected one server container, got %d", len(runs))
	}
	joined := runs[0].joined()
	for _, expected := range []string{"--read-only", "no-new-privileges:true", "--user " + currentUser(),
		deployment.libraryDir() + ":/data/library", deployment.stateDir() + ":/data/state",
		deployment.recipesDir() + ":/data/recipes:ro", deployment.secretsDir() + ":/data/secrets",
		"USHELF_ROOT=/data", "USHELF_PUBLISHED_HOST=127.0.0.1", "127.0.0.1:43110:43110", "ghcr.io/karamouche/ushelf:1.2.3"} {
		if !strings.Contains(joined, expected) {
			t.Errorf("docker run missing %q: %s", expected, joined)
		}
	}
	if strings.Contains(joined, testToken) || strings.Contains(joined, "a secret with spaces") {
		t.Fatalf("secrets leaked into Docker arguments: %s", joined)
	}
	if runs[0].envFile != "USHELF_API_TOKEN="+testToken+"\nUSHELF_APP_PASSWORD=a secret with spaces\n" {
		t.Fatalf("env file = %q", runs[0].envFile)
	}
	if matches, _ := filepath.Glob(filepath.Join(deployment.Context.Home, ".ushelf-env-*")); len(matches) != 0 {
		t.Fatalf("env file was not removed: %v", matches)
	}
	for _, expected := range []string{"Preparing the uShelf home", "Creating the uShelf service", "Waiting for uShelf to become ready"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Errorf("missing progress %q: %q", expected, stderr.String())
		}
	}
	if strings.Contains(stderr.String(), "6b88fef57f44") {
		t.Fatal("raw container ID leaked into progress output")
	}
}

func TestSSHApplyWithDomainRunsServerBehindManagedHTTPSProxy(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		if hasPrefix(dockerArgs(call), "network", "inspect") {
			return "", errors.New("no such network")
		}
		return freshDocker(call)
	}}
	deployment, _, _ := testDeployment(t, runner, ContextSpec{Driver: DriverSSH, SSH: "me@vps.example.com", Domain: "ushelf.example.com"},
		Credentials{APIToken: testToken, AppPassword: "pw"})
	if err := deployment.Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, call := range runner.calls {
		if call.name != "docker" || !hasPrefix(call.args, "--host", "ssh://me@vps.example.com") {
			t.Fatalf("command did not target the remote daemon: %s %s", call.name, call.joined())
		}
	}
	if len(runner.find(func(c fakeCall) bool { return hasPrefix(dockerArgs(c), "network", "create") })) != 1 {
		t.Fatal("expected the proxy network to be created")
	}
	server := runCalls(runner, containerName)[0].joined()
	for _, expected := range []string{"-v ushelf-data:/data", "--network ushelf", "--user " + imageUser} {
		if !strings.Contains(server, expected) {
			t.Errorf("server run missing %q: %s", expected, server)
		}
	}
	if strings.Contains(server, " -p ") || strings.Contains(server, "/data/library") {
		t.Fatalf("a proxied remote server must not publish ports or bind host paths: %s", server)
	}
	proxy := runCalls(runner, proxyContainerName)
	if len(proxy) != 1 {
		t.Fatal("expected the Caddy proxy to be created")
	}
	for _, expected := range []string{"-p 80:80", "-p 443:443", "--cap-drop ALL", proxyImage, "reverse-proxy --from ushelf.example.com --to ushelf:43110"} {
		if !strings.Contains(proxy[0].joined(), expected) {
			t.Errorf("proxy run missing %q: %s", expected, proxy[0].joined())
		}
	}
}

func TestSSHApplyWithURLPublishesOnTheRemoteHostAndDropsTheProxy(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		args := dockerArgs(call)
		switch {
		case hasPrefix(args, "container", "ls") && strings.Contains(call.joined(), "name="+proxyContainerName):
			return proxyContainerName, nil
		case hasPrefix(args, "inspect") && args[len(args)-1] == proxyContainerName:
			return "true", nil
		}
		return freshDocker(call)
	}}
	deployment, _, _ := testDeployment(t, runner, ContextSpec{Driver: DriverSSH, SSH: "me@nas", URL: "https://nas.tailnet.ts.net/"},
		Credentials{APIToken: testToken, AppPassword: "pw"})
	if err := deployment.Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if server := runCalls(runner, containerName)[0].joined(); !strings.Contains(server, "-p 127.0.0.1:43110:43110") {
		t.Fatalf("server should publish on remote loopback: %s", server)
	}
	if removed := runner.find(func(c fakeCall) bool { return hasPrefix(dockerArgs(c), "rm", "-f", proxyContainerName) }); len(removed) != 1 {
		t.Fatal("a leftover managed proxy should be removed")
	}
}

func TestReconcileKeepsAMatchingRunningContainer(t *testing.T) {
	var deployment DockerDeployment
	runner := &scriptRunner{}
	runner.handler = func(call fakeCall) (string, error) {
		args := dockerArgs(call)
		switch {
		case hasPrefix(args, "container", "ls"):
			return containerName, nil
		case hasPrefix(args, "inspect") && strings.Contains(call.joined(), "io.ushelf.managed"):
			return "true", nil
		case hasPrefix(args, "inspect") && strings.Contains(call.joined(), "io.ushelf.config"):
			return deployment.configHash(), nil
		case hasPrefix(args, "inspect") && strings.Contains(call.joined(), "State.Running"):
			return "true", nil
		}
		return freshDocker(call)
	}
	deployment, _, stderr := testDeployment(t, runner, ContextSpec{Driver: DriverLocal}, Credentials{APIToken: testToken})
	if err := deployment.Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.find(func(c fakeCall) bool { return hasPrefix(c.args, "run", "-d") || hasPrefix(c.args, "rm") })) != 0 {
		t.Fatal("a matching running container must not be recreated")
	}
	if !strings.Contains(stderr.String(), "Checking the running uShelf service") {
		t.Fatalf("missing progress: %q", stderr.String())
	}
}

func TestConfigHashCoversSecrets(t *testing.T) {
	deployment, _, _ := testDeployment(t, &scriptRunner{}, ContextSpec{Driver: DriverLocal}, Credentials{APIToken: testToken})
	base := deployment.configHash()
	deployment.Context.Credentials.AppPassword = "new"
	withPassword := deployment.configHash()
	deployment.Context.Credentials.APIToken = "rotated"
	if base == withPassword || withPassword == deployment.configHash() {
		t.Fatal("secret changes must recreate the container")
	}
}

func TestStopRefusesUnmanagedContainer(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		if hasPrefix(call.args, "container", "ls") {
			return containerName, nil
		}
		if hasPrefix(call.args, "inspect") {
			return "false", nil
		}
		return "", nil
	}}
	deployment, _, _ := testDeployment(t, runner, ContextSpec{Driver: DriverLocal}, Credentials{APIToken: testToken})
	if err := deployment.Stop(context.Background()); err == nil || !strings.Contains(err.Error(), "not managed") {
		t.Fatalf("expected ownership error, got %v", err)
	}
	if len(runner.find(func(c fakeCall) bool { return hasPrefix(c.args, "rm") })) != 0 {
		t.Fatal("unmanaged container was removed")
	}
}

func TestMaintenanceNeverReceivesIntegrationSecrets(t *testing.T) {
	for _, spec := range []ContextSpec{{Driver: DriverLocal}, {Driver: DriverSSH, SSH: "me@vps", Domain: "ushelf.example.com"}} {
		runner := &scriptRunner{handler: freshDocker}
		deployment, _, _ := testDeployment(t, runner, spec, Credentials{APIToken: testToken, AppPassword: "pw"})
		if err := deployment.RebuildIndex(context.Background()); err != nil {
			t.Fatal(err)
		}
		oneShot := runner.find(func(c fakeCall) bool { return hasPrefix(dockerArgs(c), "run", "--rm", "--init") })
		if len(oneShot) != 1 {
			t.Fatalf("%s: expected one maintenance container", spec.Driver)
		}
		joined := oneShot[0].joined()
		if strings.Contains(joined, "--env-file") || strings.Contains(joined, deployment.secretsDir()) || strings.Contains(joined, "USHELF_KINDLE_BRIDGE") {
			t.Fatalf("%s: maintenance received secrets: %s", spec.Driver, joined)
		}
		if spec.Driver == DriverSSH && !strings.Contains(joined, "--tmpfs /data/secrets") {
			t.Fatalf("remote maintenance must mask the secrets in the data volume: %s", joined)
		}
		if !strings.Contains(joined, "apps/server/dist/cli.js rebuild-index") {
			t.Fatalf("missing maintenance command: %s", joined)
		}
	}
}

func TestImportStreamsTheFileSoRemoteDaemonsCanReadIt(t *testing.T) {
	runner := &scriptRunner{handler: freshDocker}
	deployment, _, _ := testDeployment(t, runner, ContextSpec{Driver: DriverSSH, SSH: "me@vps", Domain: "ushelf.example.com"}, Credentials{APIToken: testToken})
	source := filepath.Join(t.TempDir(), "item.md")
	if err := os.WriteFile(source, []byte("---\ntitle: x\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := deployment.Import(context.Background(), source); err != nil {
		t.Fatal(err)
	}
	imports := runner.find(func(c fakeCall) bool { return strings.Contains(c.joined(), "cli.js import /tmp/import.md") })
	if len(imports) != 1 || imports[0].stdin != "---\ntitle: x\n---\n" {
		t.Fatalf("import did not stream the file: %#v", imports)
	}
	if strings.Contains(imports[0].joined(), source) {
		t.Fatal("a local path must not be bind-mounted into a remote daemon")
	}
}

func TestStartupFailureIncludesRecentLogsAndNextSteps(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		args := dockerArgs(call)
		switch {
		case hasPrefix(args, "inspect", "--format"):
			return "unhealthy", nil
		case hasPrefix(args, "logs"):
			return "Error: USHELF_API_TOKEN must be at least 32 characters\n", nil
		}
		return freshDocker(call)
	}}
	deployment, _, _ := testDeployment(t, runner, ContextSpec{Driver: DriverLocal}, Credentials{APIToken: testToken})
	err := deployment.Apply(context.Background())
	if err == nil {
		t.Fatal("expected startup failure")
	}
	for _, expected := range []string{"became unhealthy", "Recent service logs", "at least 32 characters", "ushelf logs --tail 200", "ushelf doctor"} {
		if !strings.Contains(err.Error(), expected) {
			t.Errorf("error missing %q: %v", expected, err)
		}
	}
}

func TestHealthWaitStopsOnCancellation(t *testing.T) {
	original := healthTimeout
	healthTimeout = time.Minute
	t.Cleanup(func() { healthTimeout = original })
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		if hasPrefix(dockerArgs(call), "inspect", "--format") {
			return "starting", nil
		}
		return freshDocker(call)
	}}
	deployment, _, _ := testDeployment(t, runner, ContextSpec{Driver: DriverLocal}, Credentials{APIToken: testToken})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := deployment.Apply(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}
