package cli

import (
	"path/filepath"
	"testing"
)

func TestContextURLs(t *testing.T) {
	for _, test := range []struct {
		spec ContextSpec
		want string
	}{
		{ContextSpec{Driver: DriverLocal}, "http://127.0.0.1:43110/"},
		{ContextSpec{Driver: DriverLocal, Host: "0.0.0.0", Port: 8080, BasePath: "/reader/"}, "http://127.0.0.1:8080/reader/"},
		{ContextSpec{Driver: DriverSSH, SSH: "me@vps", Domain: "shelf.example.com", BasePath: "/reader/"}, "https://shelf.example.com/reader/"},
		{ContextSpec{Driver: DriverSSH, SSH: "me@vps", URL: "https://nas.tailnet.ts.net/"}, "https://nas.tailnet.ts.net/"},
		{ContextSpec{Driver: DriverFly, App: "my-shelf", Region: "cdg"}, "https://my-shelf.fly.dev/"},
		{ContextSpec{Driver: DriverExternal, URL: "https://shelf.example.com/x/"}, "https://shelf.example.com/x/"},
	} {
		if got := (Context{Spec: test.spec}).URL(); got != test.want {
			t.Errorf("%#v: URL = %s, want %s", test.spec, got, test.want)
		}
		if err := test.spec.Validate(); err != nil {
			t.Errorf("%#v: %v", test.spec, err)
		}
	}
}

func TestContextSpecValidationRejectsMisplacedFields(t *testing.T) {
	for _, spec := range []ContextSpec{
		{Driver: DriverLocal, Domain: "shelf.example.com"},
		{Driver: DriverLocal, Port: 70000},
		{Driver: DriverSSH, SSH: "me@vps", Domain: "shelf.example.com", URL: "https://x.example/"},
		{Driver: DriverSSH, SSH: "me@vps", Domain: "not a domain"},
		{Driver: DriverFly, App: "Bad_App", Region: "cdg"},
		{Driver: DriverFly, App: "my-shelf", Region: "cdg", Port: 8080},
		{Driver: DriverExternal, URL: "http://shelf.example.com/"},
		{Driver: DriverExternal, URL: "https://shelf.example.com/", Image: "x"},
		{Driver: "kubernetes"},
	} {
		if err := spec.Validate(); err == nil {
			t.Errorf("%#v should be rejected", spec)
		}
	}
}

func TestResolveHomePrecedence(t *testing.T) {
	t.Setenv("USHELF_ROOT", "/tmp/from-env")
	if home, _ := ResolveHome("/tmp/from-flag"); home != "/tmp/from-flag" {
		t.Fatalf("flag should win, got %s", home)
	}
	if home, _ := ResolveHome(""); home != "/tmp/from-env" {
		t.Fatalf("environment should be used, got %s", home)
	}
	t.Setenv("USHELF_ROOT", "")
	t.Setenv("HOME", "/tmp/user")
	if home, _ := ResolveHome(""); home != filepath.Join("/tmp/user", ".ushelf") {
		t.Fatalf("default = %s", home)
	}
}

func TestNewAPITokenIsLongAndRandom(t *testing.T) {
	first, _ := newAPIToken()
	second, _ := newAPIToken()
	if len(first) < 43 || first == second {
		t.Fatalf("tokens %q %q", first, second)
	}
}

func TestNormalizeBasePath(t *testing.T) {
	for input, want := range map[string]string{"": "/", "/": "/", "reader": "/reader/", "/reader": "/reader/", "/reader/": "/reader/"} {
		if got := normalizeBasePath(input); got != want {
			t.Errorf("normalizeBasePath(%q) = %q, want %q", input, got, want)
		}
	}
}
