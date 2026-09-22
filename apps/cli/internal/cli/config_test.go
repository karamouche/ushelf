package cli

import (
	"path/filepath"
	"testing"
)

func TestResolveSettingsPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USHELF_ROOT", home)
	if err := writeFileConfig(filepath.Join(home, "config.json"), fileConfig{Host: "127.0.0.2", Port: 4000, BasePath: "/stored/", Image: "example/stored:1"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("USHELF_PORT", "5000")
	settings, err := ResolveSettings(FlagValues{Host: "127.0.0.3", Changed: func(name string) bool { return name == "host" }}, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if settings.Home != home {
		t.Fatalf("home = %q", settings.Home)
	}
	if settings.Host != "127.0.0.3" {
		t.Fatalf("host = %q", settings.Host)
	}
	if settings.Port != 5000 {
		t.Fatalf("port = %d", settings.Port)
	}
	if settings.BasePath != "/stored/" {
		t.Fatalf("base path = %q", settings.BasePath)
	}
	if settings.Image != "example/stored:1" {
		t.Fatalf("image = %q", settings.Image)
	}
}

func TestResolveSettingsHomeFlagOverridesRootEnvironment(t *testing.T) {
	environmentHome := t.TempDir()
	flagHome := t.TempDir()
	t.Setenv("USHELF_ROOT", environmentHome)
	settings, err := ResolveSettings(FlagValues{Home: flagHome}, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if settings.Home != flagHome {
		t.Fatalf("home = %q", settings.Home)
	}
}

func TestResolveSettingsDefaultsToDotUshelf(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, name := range []string{"USHELF_ROOT", "USHELF_HOST", "USHELF_PORT", "USHELF_WEB_BASE_PATH", "USHELF_IMAGE"} {
		t.Setenv(name, "")
	}
	t.Setenv("USHELF_HOME", filepath.Join(home, "legacy-home"))
	settings, err := ResolveSettings(FlagValues{}, "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if settings.Home != filepath.Join(home, ".ushelf") {
		t.Fatalf("home = %q", settings.Home)
	}
	if settings.Image != "ghcr.io/karamouche/ushelf:1.2.3" {
		t.Fatalf("image = %q", settings.Image)
	}
}

func TestNormalizeBasePath(t *testing.T) {
	for input, expected := range map[string]string{"": "/", "/": "/", "reader": "/reader/", "/reader/": "/reader/"} {
		if actual := normalizeBasePath(input); actual != expected {
			t.Errorf("normalizeBasePath(%q) = %q", input, actual)
		}
	}
}
