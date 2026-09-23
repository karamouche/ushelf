package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNormalizeRemoteURL(t *testing.T) {
	valid, err := normalizeRemoteURL("https://shelf.example/")
	if err != nil || valid != "https://shelf.example" {
		t.Fatalf("normalize = %q, %v", valid, err)
	}
	for _, value := range []string{"http://shelf.example", "https://user@shelf.example", "https://shelf.example/path", "not a url"} {
		if _, err := normalizeRemoteURL(value); err == nil {
			t.Errorf("normalizeRemoteURL(%q) succeeded", value)
		}
	}
}

func TestRemoteCredentialsAreOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission check")
	}
	home := t.TempDir()
	credential := remoteCredentials{ServerURL: "https://shelf.example", RefreshToken: "secret"}
	if err := saveRemoteCredentials(home, credential); err != nil {
		t.Fatal(err)
	}
	directoryInfo, err := os.Stat(filepath.Join(home, "credentials"))
	if err != nil {
		t.Fatal(err)
	}
	fileInfo, err := os.Stat(remoteCredentialsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("credentials directory mode = %04o", directoryInfo.Mode().Perm())
	}
	if fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("credential file mode = %04o", fileInfo.Mode().Perm())
	}
	loaded, err := loadRemoteCredentials(home)
	if err != nil || loaded.RefreshToken != "secret" {
		t.Fatalf("loaded = %#v, %v", loaded, err)
	}
}

func TestResolveSettingsDefaultsToLocalTarget(t *testing.T) {
	home := t.TempDir()
	settings, err := ResolveSettings(FlagValues{Home: home}, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if settings.ActiveTarget != "local" || settings.URL() != settings.LocalURL() {
		t.Fatalf("settings = %#v", settings)
	}
}
