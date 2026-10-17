package cli

import (
	"context"
	"errors"
	"io"
	"net/http"
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

func kindleCLI(t *testing.T, client *fakeKindleClient, deadline *time.Time) (*testCLI, *fakeServer) {
	t.Helper()
	cli := newTestCLI(t)
	cli.deps.Kindle = fakeKindleProvider{client: client, registerDeadline: deadline}
	server := newFakeServer(t)
	server.handle("GET /api/kindle/status", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"configured": false})
	})
	cli.addContext(t, "remote", ContextSpec{Driver: DriverExternal, URL: server.URL + "/"}, Credentials{APIToken: testToken})
	return cli, server
}

func TestKindleSetupUploadsTheCredentialToTheServer(t *testing.T) {
	client := &fakeKindleClient{}
	var registerDeadline time.Time
	cli, server := kindleCLI(t, client, &registerDeadline)
	server.handle("PUT /api/kindle/credential", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"configured": true, "accountName": "Test Account"})
	})
	cli.stdin.WriteString("y\nhttps://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=code\n")
	if err := cli.run("kindle", "setup"); err != nil {
		t.Fatalf("%v\n%s", err, cli.stderr)
	}
	assertKindleDeadline(t, registerDeadline)
	if server.bodies["PUT /api/kindle/credential"] != `{"version":1}` {
		t.Fatalf("uploaded credential = %q", server.bodies["PUT /api/kindle/credential"])
	}
	if server.tokens[len(server.tokens)-1] != testToken {
		t.Fatal("credential upload must be authenticated")
	}
	if _, err := os.Stat(filepath.Join(cli.home, "secrets", "kindle.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the credential must not be kept on the client machine")
	}
	if !strings.Contains(cli.stdout.String(), `Kindle connected for "Test Account" (NA)`) {
		t.Fatalf("stdout = %q", cli.stdout)
	}
}

func TestKindleSetupDeregistersWhenTheUploadFails(t *testing.T) {
	var deregisterDeadline time.Time
	client := &fakeKindleClient{deregisterDeadline: &deregisterDeadline}
	cli, server := kindleCLI(t, client, nil)
	server.handle("PUT /api/kindle/credential", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		respondJSON(w, map[string]any{"error": "The Kindle integration is unavailable.", "code": "bridge_unavailable"})
	})
	cli.stdin.WriteString("y\nhttps://www.amazon.com/gp/sendtokindle?code=x\n")
	err := cli.run("kindle", "setup")
	if err == nil || !strings.Contains(err.Error(), "upload Kindle credential") {
		t.Fatalf("expected upload failure, got %v", err)
	}
	assertKindleDeadline(t, deregisterDeadline)
}

func TestKindleSetupRefusesWhenAlreadyConfigured(t *testing.T) {
	cli, server := kindleCLI(t, &fakeKindleClient{}, nil)
	server.handle("GET /api/kindle/status", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"configured": true})
	})
	if err := cli.run("kindle", "setup"); err == nil || !strings.Contains(err.Error(), "already configured") {
		t.Fatalf("got %v", err)
	}
}

func TestKindleSetupRejectsUnexpectedRedirect(t *testing.T) {
	cli, server := kindleCLI(t, &fakeKindleClient{}, nil)
	cli.stdin.WriteString("y\nhttps://evil.example/gp/sendtokindle\n")
	if err := cli.run("kindle", "setup"); err == nil || !strings.Contains(err.Error(), "sendtokindle") {
		t.Fatalf("expected redirect validation error, got %v", err)
	}
	if _, uploaded := server.bodies["PUT /api/kindle/credential"]; uploaded {
		t.Fatal("nothing should be uploaded after a rejected redirect")
	}
}

func TestKindleStatusMasksDeviceSerial(t *testing.T) {
	cli, server := kindleCLI(t, &fakeKindleClient{}, nil)
	server.handle("GET /api/kindle/status", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"configured": true, "accountName": "Test Account", "homeRegion": "NA"})
	})
	server.handle("GET /api/kindle/devices", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"devices": []map[string]string{{"name": "Paperwhite", "serial": "G000PAPERWHITE1234"}}})
	})
	if err := cli.run("kindle", "status"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cli.stdout.String(), "Paperwhite · ••••1234") || strings.Contains(cli.stdout.String(), "G000PAPERWHITE") {
		t.Fatalf("stdout = %q", cli.stdout)
	}
}

func TestKindleDisconnectChoosesDeregistration(t *testing.T) {
	cli, server := kindleCLI(t, &fakeKindleClient{}, nil)
	server.handle("DELETE /api/kindle/credential", func(w http.ResponseWriter, _ *http.Request) {
		respondJSON(w, map[string]any{"disconnected": true})
	})
	if err := cli.run("kindle", "disconnect", "--skip-deregister"); err == nil || !strings.Contains(err.Error(), "requires --yes") {
		t.Fatalf("got %v", err)
	}
	if err := cli.run("kindle", "disconnect", "--yes"); err != nil {
		t.Fatal(err)
	}
	if err := cli.run("kindle", "disconnect", "--skip-deregister", "--yes"); err != nil {
		t.Fatal(err)
	}
	requests := strings.Join(server.requests, "\n")
	if !strings.Contains(requests, "DELETE /api/kindle/credential?deregister=true") || !strings.Contains(requests, "DELETE /api/kindle/credential?deregister=false") {
		t.Fatalf("requests:\n%s", requests)
	}
}
