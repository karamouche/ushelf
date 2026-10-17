package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestCommandTreeIncludesPublicContract(t *testing.T) {
	root := NewRootCommand(newTestCLI(t).deps, BuildInfo{Version: "1.2.3"})
	want := map[string]bool{
		"deploy": false, "start": false, "stop": false, "status": false, "logs": false, "open": false,
		"mcp": false, "setup": false, "doctor": false, "version": false, "update": false,
		"rebuild-index": false, "import": false, "context": false, "config": false, "kindle": false,
	}
	for _, command := range root.Commands() {
		if _, ok := want[command.Name()]; ok {
			want[command.Name()] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("missing command %q", name)
		}
	}
}

func TestDeploySSHSavesContextAndWaitsForTheTokenToBeAccepted(t *testing.T) {
	cli := newTestCLI(t)
	server := newFakeServer(t)
	t.Setenv("USHELF_APP_PASSWORD", "reader-password")
	if err := cli.run("deploy", "ssh", "me@vps.example.com", "--url", server.URL); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	config, _ := cli.store().Load()
	if config.CurrentContext != "vps" {
		t.Fatalf("current context = %q", config.CurrentContext)
	}
	if spec := config.Contexts["vps"]; spec.Driver != DriverSSH || spec.SSH != "me@vps.example.com" || spec.URL != server.URL+"/" {
		t.Fatalf("spec = %#v", spec)
	}
	credentials, _ := cli.store().LoadCredentials()
	saved := credentials["vps"]
	if len(saved.APIToken) < 32 || saved.AppPassword != "reader-password" {
		t.Fatalf("credentials = %#v", saved)
	}
	if info, err := os.Stat(cli.store().CredentialsPath()); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file mode: %v %v", info, err)
	}
	raw, _ := os.ReadFile(cli.store().ConfigPath())
	if strings.Contains(string(raw), saved.APIToken) || strings.Contains(string(raw), "reader-password") {
		t.Fatal("config.json must not contain secrets")
	}
	if !strings.Contains(strings.Join(server.tokens, " "), saved.APIToken) {
		t.Fatal("deploy did not verify the server with the saved token")
	}
	run := cli.runner.find(func(c fakeCall) bool { return hasPrefix(dockerArgs(c), "run", "-d") })
	if len(run) != 1 || !strings.Contains(run[0].envFile, "USHELF_API_TOKEN="+saved.APIToken) {
		t.Fatalf("container did not receive the saved token: %#v", run)
	}
	if !strings.Contains(cli.stdout.String(), "uShelf 9.9.9 is ready at "+server.URL+"/ (context vps)") {
		t.Fatalf("stdout = %q", cli.stdout)
	}

	// Redeploying keeps the token and password, and rejects switching the driver.
	if err := cli.run("deploy", "ssh", "me@vps.example.com", "--port", "43120"); err != nil {
		t.Fatal(err)
	}
	credentials, _ = cli.store().LoadCredentials()
	if credentials["vps"] != saved {
		t.Fatal("redeploy must keep existing credentials")
	}
	if config, _ := cli.store().Load(); config.Contexts["vps"].Port != 43120 || config.Contexts["vps"].URL == "" {
		t.Fatalf("redeploy must merge flags into the saved spec: %#v", config.Contexts["vps"])
	}
	if err := cli.run("deploy", "fly", "--name", "vps", "--app", "my-shelf", "--region", "cdg"); err == nil || !strings.Contains(err.Error(), "already uses the ssh driver") {
		t.Fatalf("expected driver conflict, got %v", err)
	}
}

func TestDeployRejectsTheServerWhenItRejectsTheToken(t *testing.T) {
	cli := newTestCLI(t)
	server := newFakeServer(t)
	server.handle("GET /api/server", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		respondJSON(w, map[string]string{"error": "Invalid API token"})
	})
	t.Setenv("USHELF_APP_PASSWORD", "pw")
	err := cli.run("deploy", "ssh", "me@vps", "--url", server.URL)
	if err == nil || !strings.Contains(err.Error(), "rejected this context's API token") {
		t.Fatalf("expected token rejection, got %v", err)
	}
}

func TestRemoteDeployRequiresAnAppPassword(t *testing.T) {
	cli := newTestCLI(t)
	err := cli.run("deploy", "ssh", "me@vps", "--domain", "shelf.example.com")
	if err == nil || !strings.Contains(err.Error(), "app password") {
		t.Fatalf("expected missing password error, got %v", err)
	}
	if len(cli.runner.calls) != 0 {
		t.Fatal("nothing should be deployed without a password")
	}
}

func TestDeployValidatesTargetsBeforeTouchingDocker(t *testing.T) {
	cli := newTestCLI(t)
	t.Setenv("USHELF_APP_PASSWORD", "pw")
	for _, args := range [][]string{
		{"deploy", "ssh", "me@vps"},
		{"deploy", "ssh", "me@vps", "--url", "http://shelf.example.com"},
		{"deploy", "ssh", "-oProxyCommand=evil", "--domain", "shelf.example.com"},
		{"deploy", "fly", "--app", "my-shelf"},
		{"deploy", "local", "--name", "Bad Name"},
	} {
		if err := cli.run(args...); err == nil {
			t.Errorf("%v should be rejected", args)
		}
	}
	if len(cli.runner.calls) != 0 {
		t.Fatalf("invalid deployments reached Docker: %v", cli.runner.calls)
	}
}

func TestContextsCanBeAddedListedSwitchedAndRemoved(t *testing.T) {
	cli := newTestCLI(t)
	server := newFakeServer(t)
	cli.addContext(t, "local", ContextSpec{Driver: DriverLocal}, Credentials{APIToken: testToken})
	cli.stdin.WriteString("external-token-0123456789abcdefghijklmnop\n")
	if err := cli.run("context", "add", "homelab", "--url", server.URL); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	if server.tokens[len(server.tokens)-1] != "external-token-0123456789abcdefghijklmnop" {
		t.Fatal("context add must verify the token")
	}
	cli.stdout.Reset()
	if err := cli.run("context", "list"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cli.stdout.String(), "*        homelab  external  "+server.URL+"/") || !strings.Contains(cli.stdout.String(), "local    local     http://127.0.0.1:43110/") {
		t.Fatalf("list:\n%s", cli.stdout)
	}
	if err := cli.run("context", "use", "local"); err != nil {
		t.Fatal(err)
	}
	cli.stdout.Reset()
	if err := cli.run("context", "show", "homelab"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(cli.stdout.String(), "external-token") || !strings.Contains(cli.stdout.String(), `"apiToken": "configured"`) {
		t.Fatalf("show must not reveal secrets:\n%s", cli.stdout)
	}
	if err := cli.run("--context", "homelab", "stop"); err == nil || !strings.Contains(err.Error(), "deployed outside uShelf") {
		t.Fatalf("external contexts cannot be stopped by the CLI: %v", err)
	}
	if err := cli.run("context", "remove", "homelab"); err != nil {
		t.Fatal(err)
	}
	credentials, _ := cli.store().LoadCredentials()
	if _, ok := credentials["homelab"]; ok {
		t.Fatal("removing a context must forget its credentials")
	}
}

func TestConfigChangesTheCurrentContextOnly(t *testing.T) {
	cli := newTestCLI(t)
	cli.addContext(t, "fly", ContextSpec{Driver: DriverFly, App: "my-shelf", Region: "cdg"}, Credentials{APIToken: testToken, AppPassword: "pw"})
	if err := cli.run("config", "set", "base-path", "reader"); err != nil {
		t.Fatal(err)
	}
	if err := cli.run("config", "set", "port", "8080"); err == nil {
		t.Fatal("fly contexts must reject a port")
	}
	if err := cli.run("config", "unset", "app-password"); err == nil {
		t.Fatal("remote contexts must keep an app password")
	}
	cli.stdout.Reset()
	if err := cli.run("config", "show"); err != nil {
		t.Fatal(err)
	}
	var shown map[string]any
	if err := json.Unmarshal(cli.stdout.Bytes(), &shown); err != nil {
		t.Fatal(err)
	}
	if shown["url"] != "https://my-shelf.fly.dev/reader/" || shown["app-password"] != "configured" || shown["base-path"] != "/reader/" {
		t.Fatalf("show = %#v", shown)
	}
	if strings.Contains(cli.stdout.String(), testToken) {
		t.Fatal("config show leaked the API token")
	}
}

func TestMCPRelaysStdioToTheContextServer(t *testing.T) {
	cli := newTestCLI(t)
	server := newFakeServer(t)
	server.handle("POST /mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
	})
	cli.addContext(t, "remote", ContextSpec{Driver: DriverExternal, URL: server.URL + "/"}, Credentials{APIToken: testToken})
	cli.stdin.WriteString(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n")
	if err := cli.run("mcp"); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(cli.stdout.String()) != `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}` {
		t.Fatalf("stdout must carry only protocol messages: %q", cli.stdout)
	}
	if server.tokens[len(server.tokens)-1] != testToken {
		t.Fatal("MCP bridge did not authenticate")
	}
}

func TestMaintenanceIsRefusedForPlatformsWithoutDockerAccess(t *testing.T) {
	cli := newTestCLI(t)
	cli.addContext(t, "fly", ContextSpec{Driver: DriverFly, App: "my-shelf", Region: "cdg"}, Credentials{APIToken: testToken})
	if err := cli.run("rebuild-index"); err == nil || !strings.Contains(err.Error(), "rebuilds its index from Markdown on startup") {
		t.Fatalf("got %v", err)
	}
}
