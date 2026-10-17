package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/cyrgim/stk"
	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
)

type bridgeProvider struct{ client *bridgeClient }

func (bridgeProvider) NewVerifier() (string, error)             { return "", nil }
func (bridgeProvider) SignInURL(string) string                  { return "" }
func (bridgeProvider) AuthorizationCode(string) (string, error) { return "", nil }
func (p bridgeProvider) Register(context.Context, string, string) (kindle.Client, error) {
	return p.client, nil
}
func (p bridgeProvider) Load(io.Reader) (kindle.Client, error) { return p.client, nil }

type bridgeClient struct {
	document kindle.Document
}

func (*bridgeClient) Marshal(io.Writer) error          { return nil }
func (*bridgeClient) AccountName() string              { return "Reader" }
func (*bridgeClient) HomeRegion() string               { return "NA" }
func (*bridgeClient) Serial() string                   { return "INSTALLATION" }
func (*bridgeClient) Deregister(context.Context) error { return nil }
func (*bridgeClient) Devices(context.Context) ([]kindle.Device, error) {
	return []kindle.Device{{Name: "Paperwhite", Serial: "DEVICE123"}}, nil
}
func (c *bridgeClient) Send(_ context.Context, document kindle.Document) (string, error) {
	c.document = document
	return "sku-123", nil
}

func TestBridgeSendTargetsOneExactDevice(t *testing.T) {
	directory := t.TempDir()
	credentialPath := filepath.Join(directory, "kindle.json")
	documentPath := filepath.Join(directory, "article.epub")
	if err := os.WriteFile(credentialPath, []byte("credential"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(documentPath, []byte("epub"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("USHELF_SECRETS_DIR", filepath.Dir(credentialPath))
	client := &bridgeClient{}
	result, err := run(
		[]string{"send"},
		bytes.NewBufferString(`{"path":"`+documentPath+`","size":4,"title":"Article","author":"A","targetSerial":"DEVICE123"}`),
		bridgeProvider{client: client},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]string)["sku"] != "sku-123" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if client.document.TargetSerial != "DEVICE123" || client.document.Size != 4 || client.document.Title != "Article" {
		t.Fatalf("unexpected document: %#v", client.document)
	}
}

func TestBridgeErrorsAreRedacted(t *testing.T) {
	mapped := mapError(&stk.APIError{Status: 403, Host: "amazon", Path: "/SendToKindle", Body: "sensitive response"})
	if mapped.Code != "credential_invalid" {
		t.Fatalf("code = %q", mapped.Code)
	}
	if mapped.Message == "" || bytes.Contains([]byte(mapped.Message), []byte("sensitive")) {
		t.Fatalf("error was not redacted: %#v", mapped)
	}
}

type marshalingClient struct{ bridgeClient }

func (*marshalingClient) Marshal(writer io.Writer) error {
	_, err := io.WriteString(writer, `{"stored":true}`)
	return err
}

type deregisteringClient struct {
	bridgeClient
	deregistered bool
}

func (c *deregisteringClient) Deregister(context.Context) error {
	c.deregistered = true
	return nil
}

type clientProvider struct {
	bridgeProvider
	client kindle.Client
}

func (p clientProvider) Load(io.Reader) (kindle.Client, error) { return p.client, nil }

func TestBridgeConnectStoresUploadedCredentialOnce(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("USHELF_SECRETS_DIR", directory)
	provider := clientProvider{client: &marshalingClient{}}
	result, err := run([]string{"connect"}, bytes.NewBufferString(`{"uploaded":true}`), provider)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]string)["accountName"] != "Reader" {
		t.Fatalf("unexpected result: %#v", result)
	}
	path := filepath.Join(directory, kindle.CredentialFilename)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode = %v", info.Mode().Perm())
	}
	if _, err := run([]string{"connect"}, bytes.NewBufferString(`{}`), provider); mapError(err).Code != "already_configured" {
		t.Fatalf("second connect error = %v", err)
	}
}

func TestBridgeConnectRejectsEmptyUpload(t *testing.T) {
	t.Setenv("USHELF_SECRETS_DIR", t.TempDir())
	if _, err := run([]string{"connect"}, bytes.NewBuffer(nil), bridgeProvider{client: &bridgeClient{}}); err == nil {
		t.Fatal("expected empty upload to fail")
	}
}

func TestBridgeDisconnectDeregistersAndRemovesCredential(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("USHELF_SECRETS_DIR", directory)
	path := filepath.Join(directory, kindle.CredentialFilename)
	if err := os.WriteFile(path, []byte("credential"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &deregisteringClient{}
	if _, err := run([]string{"disconnect"}, bytes.NewBufferString(`{"deregister":true}`), clientProvider{client: client}); err != nil {
		t.Fatal(err)
	}
	if !client.deregistered {
		t.Fatal("expected Amazon deregistration")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("credential still exists: %v", err)
	}
	if _, err := run([]string{"disconnect"}, bytes.NewBufferString(`{"deregister":false}`), clientProvider{client: client}); mapError(err).Code != "not_configured" {
		t.Fatalf("disconnect without credential error = %v", err)
	}
}
