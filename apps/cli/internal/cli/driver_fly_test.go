package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func testFly(t *testing.T, runner *scriptRunner) FlyDeployment {
	t.Helper()
	var stdout, stderr bytes.Buffer
	return FlyDeployment{
		Context: Context{Name: "ushelf", Spec: ContextSpec{Driver: DriverFly, App: "my-ushelf", Region: "cdg"},
			Credentials: Credentials{APIToken: testToken, AppPassword: "reader password"}, Home: t.TempDir(), Version: "1.2.3"},
		Runner: runner, Stdout: &stdout, Stderr: &stderr, Actions: newActionReporter(&stderr, &stdout),
	}
}

func TestFlyApplyCreatesTheAppVolumeAndSecretsBeforeDeploying(t *testing.T) {
	var flyConfig string
	deployed := false
	runner := &scriptRunner{}
	runner.handler = func(call fakeCall) (string, error) {
		switch {
		case hasPrefix(call.args, "status") && !deployed:
			return "", errors.New("Could not find App")
		case hasPrefix(call.args, "status"):
			return `{"Machines":[{"state":"started"}]}`, nil
		case hasPrefix(call.args, "volumes", "list"):
			return "[]", nil
		case hasPrefix(call.args, "deploy"):
			deployed = true
			for index, arg := range call.args {
				if arg == "--config" {
					raw, _ := os.ReadFile(call.args[index+1])
					flyConfig = string(raw)
				}
			}
		}
		return "", nil
	}
	if err := testFly(t, runner).Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	order := []string{}
	for _, call := range runner.calls {
		if call.name != "fly" {
			t.Fatalf("unexpected command %s", call.name)
		}
		order = append(order, strings.Join(call.args[:2], " "))
		if strings.Contains(call.joined(), testToken) || strings.Contains(call.joined(), "reader password") {
			t.Fatalf("secrets leaked into arguments: %s", call.joined())
		}
	}
	want := "status --app,apps create,volumes list,volumes create,secrets import,deploy --app,status --app"
	if strings.Join(order, ",") != want {
		t.Fatalf("order = %s", strings.Join(order, ","))
	}
	secrets := runner.find(func(c fakeCall) bool { return hasPrefix(c.args, "secrets", "import") })[0]
	if secrets.stdin != "USHELF_API_TOKEN="+testToken+"\nUSHELF_APP_PASSWORD=reader password\n" || !strings.Contains(secrets.joined(), "--stage") {
		t.Fatalf("secrets import = %#v", secrets)
	}
	deploy := runner.find(func(c fakeCall) bool { return hasPrefix(c.args, "deploy") })[0].joined()
	if !strings.Contains(deploy, "--image ghcr.io/karamouche/ushelf:1.2.3") || !strings.Contains(deploy, "--ha=false") {
		t.Fatalf("deploy = %s", deploy)
	}
	for _, expected := range []string{`app = "my-ushelf"`, `primary_region = "cdg"`, `source = "ushelf_data"`, `destination = "/data"`, "force_https = true", `path = "/api/health"`} {
		if !strings.Contains(flyConfig, expected) {
			t.Errorf("fly.toml missing %q:\n%s", expected, flyConfig)
		}
	}
	if strings.Contains(flyConfig, testToken) {
		t.Fatal("fly.toml must not contain secrets")
	}
}

func TestFlyApplyStartsAMachineAfterAStop(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		switch {
		case hasPrefix(call.args, "status"):
			return `{"Machines":[]}`, nil
		case hasPrefix(call.args, "volumes", "list"):
			return `[{"name":"ushelf_data","state":"created"}]`, nil
		}
		return "", nil
	}}
	if err := testFly(t, runner).Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(runner.find(func(c fakeCall) bool {
		return hasPrefix(c.args, "volumes", "create") || hasPrefix(c.args, "apps", "create")
	})) != 0 {
		t.Fatal("existing app and volume must be reused")
	}
	if scale := runner.find(func(c fakeCall) bool { return hasPrefix(c.args, "scale", "count", "1") }); len(scale) != 1 {
		t.Fatal("expected a Machine to be started")
	}
}

func TestFlyStateAndStop(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		return `{"Machines":[{"state":"stopped"},{"state":"started"}]}`, nil
	}}
	fly := testFly(t, runner)
	if state, err := fly.State(context.Background()); err != nil || state != "running" {
		t.Fatalf("state = %q, %v", state, err)
	}
	if err := fly.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if last := runner.calls[len(runner.calls)-1]; last.joined() != "scale count 0 --app my-ushelf --yes" {
		t.Fatalf("stop = %s", last.joined())
	}
}
