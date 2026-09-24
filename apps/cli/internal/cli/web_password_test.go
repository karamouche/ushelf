package cli

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func runWebPasswordConfig(t *testing.T, home, input string, args ...string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	root := NewRootCommand(Dependencies{Runner: &fakeRunner{}, Stdin: strings.NewReader(input), Stdout: &stdout, Stderr: &stderr}, BuildInfo{Version: "1.2.3"})
	root.SetArgs(append([]string{"--home", home, "config"}, args...))
	err := root.Execute()
	return stdout.String(), stderr.String(), err
}

func TestWebPasswordConfigPersistsPrivately(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USHELF_WEB_PASSWORD", "")
	secret := "a private password"
	output, diagnostics, err := runWebPasswordConfig(t, home, secret+"\n"+secret+"\n", "set", "web-password")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output+diagnostics, secret) {
		t.Fatal("password leaked in command output")
	}
	stored, err := readWebPassword(home)
	if err != nil || stored != secret {
		t.Fatalf("stored password = %q, %v", stored, err)
	}
	info, err := os.Stat(webPasswordPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("secret mode = %o", info.Mode().Perm())
	}
	show, _, err := runWebPasswordConfig(t, home, "", "show")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(show, `"web-password": "configured"`) || strings.Contains(show, secret) {
		t.Fatalf("unsafe show output: %s", show)
	}
	if _, _, err := runWebPasswordConfig(t, home, "", "set", "web-password", secret); err == nil {
		t.Fatal("password argument was accepted")
	}
	if _, _, err := runWebPasswordConfig(t, home, "", "unset", "web-password"); err != nil {
		t.Fatal(err)
	}
	stored, err = readWebPassword(home)
	if err != nil || stored != "" {
		t.Fatalf("password after unset = %q, %v", stored, err)
	}
}

func TestWebPasswordConfigRejectsMismatchAndEmpty(t *testing.T) {
	home := t.TempDir()
	for _, input := range []string{"first\nsecond\n", "\n\n"} {
		if _, _, err := runWebPasswordConfig(t, home, input, "set", "web-password"); err == nil {
			t.Fatalf("accepted invalid input %q", input)
		}
	}
	if _, err := os.Stat(webPasswordPath(home)); !os.IsNotExist(err) {
		t.Fatalf("unexpected secret file: %v", err)
	}
}

func TestWebPasswordShowReportsEnvironmentOverrideWithoutExposingIt(t *testing.T) {
	t.Setenv("USHELF_WEB_PASSWORD", "environment-secret")
	output, _, err := runWebPasswordConfig(t, t.TempDir(), "", "show")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `"web-password": "configured"`) || strings.Contains(output, "environment-secret") {
		t.Fatalf("unsafe show output: %s", output)
	}
}

func TestStoredWebPasswordChangesContainerHash(t *testing.T) {
	t.Setenv("USHELF_WEB_PASSWORD", "")
	docker := testDocker(t, &fakeRunner{}, &bytes.Buffer{}, &bytes.Buffer{})
	without := mustConfigHash(t, docker)
	if err := writeWebPassword(docker.Settings.Home, "first"); err != nil {
		t.Fatal(err)
	}
	first := mustConfigHash(t, docker)
	if first == without {
		t.Fatal("saved password did not change container configuration")
	}
	if err := writeWebPassword(docker.Settings.Home, "second"); err != nil {
		t.Fatal(err)
	}
	if first == mustConfigHash(t, docker) {
		t.Fatal("password change did not change container configuration")
	}
	if err := unsetWebPassword(docker.Settings.Home); err != nil {
		t.Fatal(err)
	}
	if without != mustConfigHash(t, docker) {
		t.Fatal("unsetting password did not restore container configuration")
	}
}
