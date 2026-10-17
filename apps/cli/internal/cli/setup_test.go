package cli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/karamouche/ushelf/apps/cli/internal/api"
)

var testRegistration = mcpRegistration{Executable: "/usr/local/bin/ushelf", Home: "/Users/test/.ushelf", Context: "vps"}

func TestInstallSkillsWritesTheServerBundleAndRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	bundle := api.SkillBundle{Version: "1.2.3", Skills: []api.Skill{{Name: "ushelf-ingest", Files: []api.SkillFile{
		{Path: "SKILL.md", Content: "# Ingest"}, {Path: "agents/openai.yaml", Content: "name: x"},
	}}}}
	target, err := installSkills(root, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if contents, _ := os.ReadFile(filepath.Join(target, "ushelf-ingest", "agents", "openai.yaml")); string(contents) != "name: x" {
		t.Fatalf("nested skill file = %q", contents)
	}
	for _, bad := range []api.SkillBundle{
		{Version: "1.2.3", Skills: []api.Skill{{Name: "x", Files: []api.SkillFile{{Path: "../../escape", Content: "x"}}}}},
		{Version: "1.2.3", Skills: []api.Skill{{Name: "x", Files: []api.SkillFile{{Path: "/etc/passwd", Content: "x"}}}}},
		{Version: "1.2.3", Skills: []api.Skill{{Name: "../x", Files: []api.SkillFile{{Path: "SKILL.md", Content: "x"}}}}},
		{Version: "../1", Skills: nil},
	} {
		if _, err := installSkills(root, bad); err == nil {
			t.Errorf("bundle %#v should be rejected", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("traversal wrote outside the assets directory")
	}
}

func TestSetupCommandLinePinsTheContext(t *testing.T) {
	expected := `claude mcp add --scope user ushelf -- "/usr/local/bin/ushelf" --home "/Users/test/.ushelf" --context "vps" mcp`
	if actual := testRegistration.commandLine("claude"); actual != expected {
		t.Fatalf("command = %q", actual)
	}
}

func TestSetupInstallsServerSkillsAndRegistersTheMCPBridge(t *testing.T) {
	cli := newTestCLI(t)
	t.Setenv("HOME", t.TempDir())
	server := newFakeServer(t)
	server.handle("GET /api/agent/skills", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, api.SkillBundle{Version: "9.9.9", Skills: []api.Skill{
			{Name: "ushelf-ingest", Files: []api.SkillFile{{Path: "SKILL.md", Content: "# Ingest"}}},
			{Name: "ushelf-library", Files: []api.SkillFile{{Path: "SKILL.md", Content: "# Library"}}},
		}})
	})
	cli.runner.handler = func(call fakeCall) (string, error) {
		if hasPrefix(call.args, "mcp", "get") {
			return "", errors.New("not found")
		}
		return "", nil
	}
	cli.addContext(t, "vps", ContextSpec{Driver: DriverExternal, URL: server.URL + "/"}, Credentials{APIToken: testToken})
	if err := cli.run("setup", "claude"); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	add := cli.runner.find(func(c fakeCall) bool { return c.name == "claude" && hasPrefix(c.args, "mcp", "add") })
	if len(add) != 1 || !strings.HasSuffix(add[0].joined(), "--home "+cli.home+" --context vps mcp") {
		t.Fatalf("registration = %#v", add)
	}
	link, err := os.Readlink(filepath.Join(os.Getenv("HOME"), ".claude", "skills", "ushelf-library"))
	if err != nil || link != filepath.Join(cli.home, "assets", "skills", "9.9.9", "ushelf-library") {
		t.Fatalf("skill link = %q, %v", link, err)
	}
}

func TestReplaceSymlinkAtomically(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "skill")
	if err := os.Symlink(filepath.Join(root, "old"), destination); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "new")
	if err := replaceSymlink(want, destination); err != nil {
		t.Fatal(err)
	}
	if got, err := os.Readlink(destination); err != nil || got != want {
		t.Fatalf("target = %q, %v", got, err)
	}
	if _, err := os.Lstat(destination + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary link was not cleaned up: %v", err)
	}
}

func TestPathWithinSupportsCustomHome(t *testing.T) {
	root := filepath.Join(t.TempDir(), "custom-home", "assets")
	if !pathWithin(root, filepath.Join(root, "skills", "1.2.3")) {
		t.Fatal("versioned custom asset path should be managed")
	}
	if pathWithin(root, filepath.Join(filepath.Dir(root), "unrelated")) {
		t.Fatal("unrelated path should not be managed")
	}
}

func configureState(runner Runner) *commandState {
	return &commandState{deps: Dependencies{Runner: runner}}
}

func TestConfigureClientRejectsConflictWithoutForce(t *testing.T) {
	other := testRegistration
	other.Context = "local"
	runner := &scriptRunner{handler: func(fakeCall) (string, error) { return codexMCPOutput(t, other), nil }}
	err := configureState(runner).configureClient(context.Background(), "codex", testRegistration, false)
	if err == nil || !strings.Contains(err.Error(), "conflicting") {
		t.Fatalf("expected conflict error, got %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("conflicting entry was modified: %#v", runner.calls)
	}
}

func TestConfigureClientForceReplacesConflict(t *testing.T) {
	runner := &scriptRunner{handler: func(call fakeCall) (string, error) {
		if hasPrefix(call.args, "mcp", "get") {
			return "ushelf:\n  Command: something-else\n  Args: mcp\n", nil
		}
		return "", nil
	}}
	if err := configureState(runner).configureClient(context.Background(), "claude", testRegistration, true); err != nil {
		t.Fatal(err)
	}
	last := runner.calls[len(runner.calls)-1]
	if last.name != "claude" || !strings.Contains(last.joined(), "mcp add --scope user ushelf -- /usr/local/bin/ushelf --home /Users/test/.ushelf --context vps mcp") {
		t.Fatalf("unexpected add call: %#v", last)
	}
}

func TestConfigureClientsAcceptExactConfiguration(t *testing.T) {
	codex := &scriptRunner{handler: func(fakeCall) (string, error) { return codexMCPOutput(t, testRegistration), nil }}
	if err := configureState(codex).configureClient(context.Background(), "codex", testRegistration, false); err != nil {
		t.Fatal(err)
	}
	if len(codex.calls) != 1 || !strings.Contains(codex.calls[0].joined(), "--json") {
		t.Fatalf("expected one JSON inspection call, got %#v", codex.calls)
	}
	output := "ushelf:\n  Command: /usr/local/bin/ushelf\n  Args: --home /Users/test/.ushelf --context vps mcp\n"
	claude := &scriptRunner{handler: func(fakeCall) (string, error) { return output, nil }}
	if err := configureState(claude).configureClient(context.Background(), "claude", testRegistration, false); err != nil {
		t.Fatal(err)
	}
	if len(claude.calls) != 1 {
		t.Fatalf("matching entry was unexpectedly modified: %#v", claude.calls)
	}
}

func TestConfigureClientRejectsMalformedInspectionOutput(t *testing.T) {
	runner := &scriptRunner{handler: func(fakeCall) (string, error) { return "not json", nil }}
	err := configureState(runner).configureClient(context.Background(), "codex", testRegistration, false)
	if err == nil || !strings.Contains(err.Error(), "parse Codex MCP configuration") {
		t.Fatalf("expected parse error, got %v", err)
	}
}

func codexMCPOutput(t *testing.T, registration mcpRegistration) string {
	t.Helper()
	contents, err := json.Marshal(map[string]any{
		"transport": map[string]any{"type": "stdio", "command": registration.Executable, "args": registration.args()},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}
