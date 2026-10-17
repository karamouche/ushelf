package cli

import (
	"net/http"
	"strings"
	"testing"
)

func connectorsCLI(t *testing.T) (*testCLI, *fakeServer) {
	t.Helper()
	cli := newTestCLI(t)
	server := newFakeServer(t)
	cli.addContext(t, "remote", ContextSpec{Driver: DriverExternal, URL: server.URL + "/reader/"}, Credentials{APIToken: testToken})
	return cli, server
}

func TestConnectorsListsAuthorizedAppsAndTheConnectorURL(t *testing.T) {
	cli, server := connectorsCLI(t)
	server.handle("GET /reader/api/connectors", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"connectors": []map[string]any{{
			"clientId":     "client-1",
			"clientName":   "Claude",
			"redirectUris": []string{"https://claude.ai/api/mcp/auth_callback"},
			"connectedAt":  "2026-10-17T12:00:00.000Z",
			"lastUsedAt":   "2026-10-17T13:00:00.000Z",
		}}})
	})
	if err := cli.run("connectors"); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	output := cli.stdout.String()
	for _, want := range []string{"Connector URL: " + server.URL + "/reader/mcp", "public HTTPS URL", "Claude", "claude.ai", "client-1"} {
		if !strings.Contains(output, want) {
			t.Fatalf("stdout %q does not contain %q", output, want)
		}
	}
	if server.tokens[len(server.tokens)-1] != testToken {
		t.Fatal("listing connectors must use the API token")
	}
}

func TestConnectorsRevokeOneOrAll(t *testing.T) {
	cli, server := connectorsCLI(t)
	server.handle("DELETE /reader/api/connectors/client-1", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"revoked": 1})
	})
	server.handle("DELETE /reader/api/connectors", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"revoked": 2})
	})
	if err := cli.run("connectors", "revoke", "client-1"); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	if err := cli.run("connectors", "revoke", "missing"); err == nil || !strings.Contains(err.Error(), "no connector has client ID missing") {
		t.Fatalf("got %v", err)
	}
	if err := cli.run("connectors", "revoke"); err == nil {
		t.Fatal("revoke without a client ID or --all must fail")
	}
	cli.stdin.WriteString("n\n")
	if err := cli.run("connectors", "revoke", "--all"); err == nil || !strings.Contains(err.Error(), "cancelled") {
		t.Fatalf("got %v", err)
	}
	if err := cli.run("connectors", "revoke", "--all", "--yes"); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	if !strings.Contains(cli.stdout.String()+cli.stderr.String(), "Revoked 2 connectors") {
		t.Fatalf("output = %q %q", cli.stdout, cli.stderr)
	}
}
