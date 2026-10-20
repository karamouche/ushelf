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
		{ContextSpec{Driver: DriverSSH, SSH: "me@vps", Domain: "ushelf.example.com", BasePath: "/reader/"}, "https://ushelf.example.com/reader/"},
		{ContextSpec{Driver: DriverSSH, SSH: "me@vps", URL: "https://nas.tailnet.ts.net/"}, "https://nas.tailnet.ts.net/"},
		{ContextSpec{Driver: DriverFly, App: "my-ushelf", Region: "cdg"}, "https://my-ushelf.fly.dev/"},
		{ContextSpec{Driver: DriverExternal, URL: "https://ushelf.example.com/x/"}, "https://ushelf.example.com/x/"},
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
		{Driver: DriverLocal, Domain: "ushelf.example.com"},
		{Driver: DriverLocal, Port: 70000},
		{Driver: DriverSSH, SSH: "me@vps", Domain: "ushelf.example.com", URL: "https://x.example/"},
		{Driver: DriverSSH, SSH: "me@vps", Domain: "not a domain"},
		{Driver: DriverFly, App: "Bad_App", Region: "cdg"},
		{Driver: DriverFly, App: "my-ushelf", Region: "cdg", Port: 8080},
		{Driver: DriverExternal, URL: "http://ushelf.example.com/"},
		{Driver: DriverExternal, URL: "https://ushelf.example.com/", Image: "x"},
		{Driver: "kubernetes"},
	} {
		if err := spec.Validate(); err == nil {
			t.Errorf("%#v should be rejected", spec)
		}
	}
}

func TestOnlyLoopbackLocalContextsMayOmitTheAppPassword(t *testing.T) {
	for _, test := range []struct {
		spec ContextSpec
		want bool
	}{
		{ContextSpec{Driver: DriverLocal}, false},
		{ContextSpec{Driver: DriverLocal, Host: "127.0.0.1"}, false},
		{ContextSpec{Driver: DriverLocal, Host: "localhost"}, false},
		{ContextSpec{Driver: DriverLocal, Host: "::1"}, false},
		{ContextSpec{Driver: DriverLocal, Host: "0.0.0.0"}, true},
		{ContextSpec{Driver: DriverLocal, Host: "::"}, true},
		{ContextSpec{Driver: DriverLocal, Host: "192.168.1.20"}, true},
		{ContextSpec{Driver: DriverLocal, Host: "127.0.0.2"}, true},
		{ContextSpec{Driver: DriverSSH, SSH: "me@vps", Domain: "ushelf.example.com"}, true},
		{ContextSpec{Driver: DriverFly, App: "my-ushelf", Region: "cdg"}, true},
		{ContextSpec{Driver: DriverExternal, URL: "https://ushelf.example.com/"}, false},
	} {
		if got := test.spec.RequiresAppPassword(); got != test.want {
			t.Errorf("%#v: RequiresAppPassword = %v, want %v", test.spec, got, test.want)
		}
		err := requirePasswordFor(test.spec, Credentials{APIToken: testToken})
		if (err != nil) != test.want {
			t.Errorf("%#v: requirePasswordFor without a password = %v", test.spec, err)
		}
		if err := requirePasswordFor(test.spec, Credentials{APIToken: testToken, AppPassword: "pw"}); err != nil {
			t.Errorf("%#v: requirePasswordFor with a password = %v", test.spec, err)
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
