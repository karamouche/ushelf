package cli

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUntarSkillsRejectsTraversal(t *testing.T) {
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	if err := writer.WriteHeader(&tar.Header{Name: "../../escape", Mode: 0o600, Size: 1, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := untarSkills(archive.Bytes(), t.TempDir()); err == nil {
		t.Fatal("expected traversal archive to fail")
	}
}

func TestSetupCommandLineUsesUserScopeForClaude(t *testing.T) {
	actual := setupCommandLine("claude", "/usr/local/bin/ushelf", "/Users/test/.ushelf")
	expected := `claude mcp add --scope user ushelf -- "/usr/local/bin/ushelf" --home "/Users/test/.ushelf" mcp`
	if actual != expected {
		t.Fatalf("command = %q", actual)
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
	got, err := os.Readlink(destination)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("target = %q", got)
	}
	if _, err := os.Lstat(destination + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary link was not cleaned up: %v", err)
	}
}

func TestPathWithinSupportsCustomHome(t *testing.T) {
	root := filepath.Join(t.TempDir(), "custom-home", "assets")
	if !pathWithin(root, filepath.Join(root, "1.2.3", "skills")) {
		t.Fatal("versioned custom asset path should be managed")
	}
	if pathWithin(root, filepath.Join(filepath.Dir(root), "unrelated")) {
		t.Fatal("unrelated path should not be managed")
	}
}

func TestConfigureClientRejectsConflictWithoutForce(t *testing.T) {
	home := t.TempDir()
	runner := &fakeRunner{outputs: []fakeResult{{output: codexMCPOutput(t, "/usr/local/bin/ushelf", []string{"--home", "/other/home", "mcp"})}}}
	state := &commandState{
		deps:     Dependencies{Runner: runner, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		settings: Settings{Home: home},
	}
	err := state.configureClient(context.Background(), "codex", "/usr/local/bin/ushelf", false)
	if err == nil || !strings.Contains(err.Error(), "conflicting") {
		t.Fatalf("expected conflict error, got %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("conflicting entry was modified: %#v", runner.calls)
	}
}

func TestConfigureClientForceReplacesConflict(t *testing.T) {
	runner := &fakeRunner{outputs: []fakeResult{{output: "ushelf:\n  Command: something-else\n  Args: mcp\n"}, {}}}
	state := &commandState{
		deps:     Dependencies{Runner: runner, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		settings: Settings{Home: t.TempDir()},
	}
	if err := state.configureClient(context.Background(), "claude", "/usr/local/bin/ushelf", true); err != nil {
		t.Fatal(err)
	}
	last := runner.calls[len(runner.calls)-1]
	joined := strings.Join(last.args, " ")
	if last.name != "claude" || !strings.Contains(joined, "mcp add --scope user ushelf") {
		t.Fatalf("unexpected add call: %#v", last)
	}
}

func TestConfigureCodexClientAcceptsExactConfiguration(t *testing.T) {
	home := t.TempDir()
	executable := "/usr/local/bin/ushelf"
	runner := &fakeRunner{outputs: []fakeResult{{output: codexMCPOutput(t, executable, []string{"--home", home, "mcp"})}}}
	state := &commandState{
		deps:     Dependencies{Runner: runner, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		settings: Settings{Home: home},
	}
	if err := state.configureClient(context.Background(), "codex", executable, false); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 || !strings.Contains(strings.Join(runner.calls[0].args, " "), "--json") {
		t.Fatalf("expected one JSON inspection call, got %#v", runner.calls)
	}
}

func TestConfigureClaudeClientAcceptsExactConfiguration(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home with spaces")
	executable := "/usr/local/bin/ushelf"
	output := "ushelf:\n  Command: " + executable + "\n  Args: --home " + home + " mcp\n"
	runner := &fakeRunner{outputs: []fakeResult{{output: output}}}
	state := &commandState{
		deps:     Dependencies{Runner: runner, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		settings: Settings{Home: home},
	}
	if err := state.configureClient(context.Background(), "claude", executable, false); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("matching entry was unexpectedly modified: %#v", runner.calls)
	}
}

func TestConfigureClaudeClientRejectsWrongHome(t *testing.T) {
	home := t.TempDir()
	executable := "/usr/local/bin/ushelf"
	output := "ushelf:\n  Command: " + executable + "\n  Args: --home /other/home mcp\n"
	runner := &fakeRunner{outputs: []fakeResult{{output: output}}}
	state := &commandState{
		deps:     Dependencies{Runner: runner, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		settings: Settings{Home: home},
	}
	err := state.configureClient(context.Background(), "claude", executable, false)
	if err == nil || !strings.Contains(err.Error(), "conflicting") {
		t.Fatalf("expected conflict error, got %v", err)
	}
}

func TestConfigureClientRejectsMalformedInspectionOutput(t *testing.T) {
	state := &commandState{
		deps: Dependencies{
			Runner: &fakeRunner{outputs: []fakeResult{{output: "not json"}}},
			Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		},
		settings: Settings{Home: t.TempDir()},
	}
	err := state.configureClient(context.Background(), "codex", "/usr/local/bin/ushelf", false)
	if err == nil || !strings.Contains(err.Error(), "parse Codex MCP configuration") {
		t.Fatalf("expected parse error, got %v", err)
	}
}

func codexMCPOutput(t *testing.T, command string, args []string) string {
	t.Helper()
	contents, err := json.Marshal(map[string]any{
		"transport": map[string]any{"type": "stdio", "command": command, "args": args},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}
