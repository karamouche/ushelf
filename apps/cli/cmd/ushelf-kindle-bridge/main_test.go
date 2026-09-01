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
