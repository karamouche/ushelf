package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
)

type fakeKindleProvider struct {
	client *fakeKindleClient
}

func (f fakeKindleProvider) NewVerifier() (string, error) { return "verifier", nil }
func (f fakeKindleProvider) SignInURL(string) string      { return "https://www.amazon.com/ap/signin" }
func (f fakeKindleProvider) AuthorizationCode(string) (string, error) {
	return "authorization-code", nil
}
func (f fakeKindleProvider) Register(context.Context, string, string) (kindle.Client, error) {
	return f.client, nil
}
func (f fakeKindleProvider) Load(io.Reader) (kindle.Client, error) { return f.client, nil }

type fakeKindleClient struct {
	devices       []kindle.Device
	deregisterErr error
}

func (f *fakeKindleClient) Marshal(writer io.Writer) error {
	_, err := io.WriteString(writer, `{"version":1}`)
	return err
}
func (f *fakeKindleClient) AccountName() string { return "Test Account" }
func (f *fakeKindleClient) HomeRegion() string  { return "NA" }
func (f *fakeKindleClient) Serial() string      { return "INSTALLATION1234" }
func (f *fakeKindleClient) Devices(context.Context) ([]kindle.Device, error) {
	return f.devices, nil
}
func (f *fakeKindleClient) Send(context.Context, kindle.Document) (string, error) {
	return "sku", nil
}
func (f *fakeKindleClient) Deregister(context.Context) error { return f.deregisterErr }

func TestKindleSetupStoresOwnerReadableCredential(t *testing.T) {
	home := t.TempDir()
	stdout := &bytes.Buffer{}
	client := &fakeKindleClient{}
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{},
			Stdin:  strings.NewReader("yes\nhttps://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=code\n"),
			Stdout: stdout,
			Stderr: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: client},
		},
		BuildInfo{Version: "test"},
	)
	root.SetArgs([]string{"--home", home, "kindle", "setup"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	credentialPath := kindle.CredentialPath(home)
	info, err := os.Stat(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode = %04o, want 0600", info.Mode().Perm())
	}
	if !strings.Contains(stdout.String(), "Kindle connected") {
		t.Fatalf("missing success output: %s", stdout.String())
	}
}

func TestKindleSetupRejectsUnexpectedRedirect(t *testing.T) {
	home := t.TempDir()
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{}, Stdin: strings.NewReader("yes\nhttps://example.com/?openid.oa2.authorization_code=code\n"),
			Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}, Kindle: fakeKindleProvider{client: &fakeKindleClient{}},
		},
		BuildInfo{Version: "test"},
	)
	root.SetArgs([]string{"--home", home, "kindle", "setup"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "amazon.com") {
		t.Fatalf("expected redirect validation error, got %v", err)
	}
	if _, err := os.Stat(kindle.CredentialPath(home)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("credential was written after invalid redirect")
	}
}

func TestKindleStatusMasksDeviceSerial(t *testing.T) {
	home := t.TempDir()
	credentialPath := kindle.CredentialPath(home)
	if err := os.MkdirAll(filepath.Dir(credentialPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentialPath, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout := &bytes.Buffer{}
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: stdout, Stderr: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: &fakeKindleClient{devices: []kindle.Device{{Name: "Paperwhite", Serial: "ABCDEFGHIJKL"}}}},
		},
		BuildInfo{Version: "test"},
	)
	root.SetArgs([]string{"--home", home, "kindle", "status"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if output := stdout.String(); !strings.Contains(output, "••••IJKL") || strings.Contains(output, "ABCDEFGHIJKL") {
		t.Fatalf("device serial was not masked: %s", output)
	}
}

func TestKindleDisconnectPreservesCredentialWhenDeregistrationFails(t *testing.T) {
	home := t.TempDir()
	credentialPath := kindle.CredentialPath(home)
	if err := os.MkdirAll(filepath.Dir(credentialPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentialPath, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: &fakeKindleClient{deregisterErr: errors.New("Amazon unavailable")}},
		},
		BuildInfo{Version: "test"},
	)
	root.SetArgs([]string{"--home", home, "kindle", "disconnect", "--yes"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected deregistration failure")
	}
	if _, err := os.Stat(credentialPath); err != nil {
		t.Fatal("credential was removed after deregistration failure")
	}
}
