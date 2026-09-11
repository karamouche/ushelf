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
	"time"

	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
)

type fakeKindleProvider struct {
	client           *fakeKindleClient
	registerDeadline *time.Time
}

func (f fakeKindleProvider) NewVerifier() (string, error) { return "verifier", nil }
func (f fakeKindleProvider) SignInURL(string) string      { return "https://www.amazon.com/ap/signin" }
func (f fakeKindleProvider) AuthorizationCode(string) (string, error) {
	return "authorization-code", nil
}
func (f fakeKindleProvider) Register(ctx context.Context, _, _ string) (kindle.Client, error) {
	recordDeadline(ctx, f.registerDeadline)
	return f.client, nil
}
func (f fakeKindleProvider) Load(io.Reader) (kindle.Client, error) { return f.client, nil }

type fakeKindleClient struct {
	devices            []kindle.Device
	deregisterErr      error
	deviceDeadline     *time.Time
	deregisterDeadline *time.Time
}

func (f *fakeKindleClient) Marshal(writer io.Writer) error {
	_, err := io.WriteString(writer, `{"version":1}`)
	return err
}
func (f *fakeKindleClient) AccountName() string { return "Test Account" }
func (f *fakeKindleClient) HomeRegion() string  { return "NA" }
func (f *fakeKindleClient) Serial() string      { return "INSTALLATION1234" }

func (f *fakeKindleClient) Devices(ctx context.Context) ([]kindle.Device, error) {
	recordDeadline(ctx, f.deviceDeadline)
	return f.devices, nil
}
func (f *fakeKindleClient) Send(context.Context, kindle.Document) (string, error) {
	return "sku", nil
}
func (f *fakeKindleClient) Deregister(ctx context.Context) error {
	recordDeadline(ctx, f.deregisterDeadline)
	return f.deregisterErr
}

func recordDeadline(ctx context.Context, target *time.Time) {
	if target == nil {
		return
	}
	*target, _ = ctx.Deadline()
}

func assertKindleDeadline(t *testing.T, deadline time.Time) {
	t.Helper()
	remaining := time.Until(deadline)
	if deadline.IsZero() || remaining <= 0 || remaining > kindle.OperationTimeout {
		t.Fatalf("Kindle operation deadline has %s remaining, want within (0, %s]", remaining, kindle.OperationTimeout)
	}
}

func TestKindleSetupStoresOwnerReadableCredential(t *testing.T) {
	home := t.TempDir()
	stdout := &bytes.Buffer{}
	client := &fakeKindleClient{}
	var registerDeadline time.Time
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{},
			Stdin:  strings.NewReader("yes\nhttps://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=code\n"),
			Stdout: stdout,
			Stderr: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: client, registerDeadline: &registerDeadline},
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
	assertKindleDeadline(t, registerDeadline)
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
	var deviceDeadline time.Time
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: stdout, Stderr: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: &fakeKindleClient{
				devices: []kindle.Device{{Name: "Paperwhite", Serial: "ABCDEFGHIJKL"}}, deviceDeadline: &deviceDeadline,
			}},
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
	assertKindleDeadline(t, deviceDeadline)
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
	var deregisterDeadline time.Time
	root := NewRootCommand(
		Dependencies{
			Runner: &fakeRunner{}, Stdin: &bytes.Buffer{}, Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: &fakeKindleClient{
				deregisterErr: errors.New("Amazon unavailable"), deregisterDeadline: &deregisterDeadline,
			}},
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
	assertKindleDeadline(t, deregisterDeadline)
}

func TestKindleDoctorUsesOperationDeadline(t *testing.T) {
	home := t.TempDir()
	credentialPath := kindle.CredentialPath(home)
	if err := os.MkdirAll(filepath.Dir(credentialPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentialPath, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var deviceDeadline time.Time
	state := commandState{
		deps: Dependencies{
			Stdout: &bytes.Buffer{},
			Kindle: fakeKindleProvider{client: &fakeKindleClient{deviceDeadline: &deviceDeadline}},
		},
		settings: Settings{Home: home},
	}

	state.reportKindleDoctor(context.Background())

	assertKindleDeadline(t, deviceDeadline)
}
