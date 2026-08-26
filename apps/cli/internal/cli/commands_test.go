package cli

import (
	"bytes"
	"testing"
)

func TestCommandTreeIncludesPublicContractWithoutMigrate(t *testing.T) {
	root := NewRootCommand(
		Dependencies{Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}},
		BuildInfo{Version: "1.2.3", Commit: "test", BuildDate: "today"},
	)
	want := map[string]bool{
		"start": false, "stop": false, "status": false, "logs": false, "open": false,
		"mcp": false, "setup": false, "doctor": false, "version": false, "update": false,
		"rebuild-index": false, "import": false, "config": false,
	}
	for _, command := range root.Commands() {
		if command.Name() == "migrate" {
			t.Fatal("migrate must not be part of the public command tree")
		}
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
