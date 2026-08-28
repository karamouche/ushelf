package cli

import (
	"bytes"
	"strings"
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

func TestConfigHelpListsKeysAndExamples(t *testing.T) {
	stdout := &bytes.Buffer{}
	root := NewRootCommand(
		Dependencies{Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: stdout, Stderr: &bytes.Buffer{}},
		BuildInfo{Version: "1.2.3"},
	)
	root.SetArgs([]string{"config", "--help"})

	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	output := stdout.String()
	for _, expected := range []string{
		"Configurable keys:",
		"host       Address published by Docker",
		"port       HTTP port",
		"base-path  Web app and API URL prefix",
		"image      Runtime Docker image",
		"ushelf config set base-path /reader/",
		"show",
		"path",
		"set",
		"unset",
	} {
		if !strings.Contains(output, expected) {
			t.Errorf("config help missing %q:\n%s", expected, output)
		}
	}
}

func TestConfigSetHelpListsKeys(t *testing.T) {
	stdout := &bytes.Buffer{}
	root := NewRootCommand(
		Dependencies{Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: stdout, Stderr: &bytes.Buffer{}},
		BuildInfo{Version: "1.2.3"},
	)
	root.SetArgs([]string{"config", "set", "--help"})

	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if output := stdout.String(); !strings.Contains(output, "Configurable keys:") || !strings.Contains(output, "ushelf config set port 43120") {
		t.Fatalf("config set help does not describe keys and examples:\n%s", output)
	}
}

func TestConfigSetWithoutArgumentsDisplaysKeys(t *testing.T) {
	stdout := &bytes.Buffer{}
	root := NewRootCommand(
		Dependencies{Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: stdout, Stderr: &bytes.Buffer{}},
		BuildInfo{Version: "1.2.3"},
	)
	root.SetArgs([]string{"--home", t.TempDir(), "config", "set"})

	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	output := stdout.String()
	if !strings.Contains(output, "Configurable keys:") || !strings.Contains(output, "ushelf config set base-path /reader/") {
		t.Fatalf("config set without arguments does not describe keys and examples:\n%s", output)
	}
}

func TestConfigShowUsesCLIKeyNames(t *testing.T) {
	stdout := &bytes.Buffer{}
	root := NewRootCommand(
		Dependencies{Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: stdout, Stderr: &bytes.Buffer{}},
		BuildInfo{Version: "1.2.3"},
	)
	root.SetArgs([]string{"--home", t.TempDir(), "config", "show"})

	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	output := stdout.String()
	if !strings.Contains(output, `"base-path": "/"`) {
		t.Fatalf("config show missing CLI key name:\n%s", output)
	}
	if strings.Contains(output, `"basePath"`) {
		t.Fatalf("config show contains storage key name:\n%s", output)
	}
}
