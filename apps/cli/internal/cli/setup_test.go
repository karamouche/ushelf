package cli

import (
	"archive/tar"
	"bytes"
	"context"
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
	runner := &fakeRunner{outputs: []fakeResult{{output: "command: something-else"}}}
	state := &commandState{
		deps:     Dependencies{Runner: runner, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		settings: Settings{Home: t.TempDir()},
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
	runner := &fakeRunner{outputs: []fakeResult{{output: "command: something-else"}, {}}}
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
