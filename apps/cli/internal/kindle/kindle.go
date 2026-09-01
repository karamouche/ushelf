package kindle

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/cyrgim/stk"
)

const CredentialFilename = "kindle.json"

type Device struct {
	Name   string `json:"name"`
	Serial string `json:"serial"`
}

type Document struct {
	Content      io.Reader
	Size         int64
	Title        string
	Author       string
	TargetSerial string
}

type Client interface {
	Marshal(io.Writer) error
	AccountName() string
	HomeRegion() string
	Serial() string
	Devices(context.Context) ([]Device, error)
	Send(context.Context, Document) (string, error)
	Deregister(context.Context) error
}

type Provider interface {
	NewVerifier() (string, error)
	SignInURL(string) string
	AuthorizationCode(string) (string, error)
	Register(context.Context, string, string) (Client, error)
	Load(io.Reader) (Client, error)
}

type STKProvider struct{}

func (STKProvider) NewVerifier() (string, error)     { return stk.NewVerifier() }
func (STKProvider) SignInURL(verifier string) string { return stk.SignInURL(verifier) }
func (STKProvider) AuthorizationCode(redirect string) (string, error) {
	return stk.AuthorizationCode(redirect)
}
func (STKProvider) Register(ctx context.Context, code, verifier string) (Client, error) {
	client, err := stk.Register(ctx, code, verifier, stk.WithDeviceName("uShelf"))
	if err != nil {
		return nil, err
	}
	return stkClient{client}, nil
}
func (STKProvider) Load(reader io.Reader) (Client, error) {
	client, err := stk.Load(reader)
	if err != nil {
		return nil, err
	}
	return stkClient{client}, nil
}

type stkClient struct{ client *stk.Client }

func (c stkClient) Marshal(writer io.Writer) error { return c.client.Marshal(writer) }
func (c stkClient) AccountName() string            { return c.client.AccountName() }
func (c stkClient) HomeRegion() string             { return c.client.HomeRegion() }
func (c stkClient) Serial() string                 { return c.client.Serial() }
func (c stkClient) Deregister(ctx context.Context) error {
	return c.client.Deregister(ctx)
}
func (c stkClient) Devices(ctx context.Context) ([]Device, error) {
	owned, err := c.client.Devices(ctx)
	if err != nil {
		return nil, err
	}
	devices := make([]Device, 0, len(owned))
	for _, device := range owned {
		devices = append(devices, Device{Name: device.Name, Serial: device.Serial})
	}
	return devices, nil
}
func (c stkClient) Send(ctx context.Context, document Document) (string, error) {
	return c.client.Send(ctx, stk.Document{
		Content:   document.Content,
		Size:      document.Size,
		Title:     document.Title,
		Author:    document.Author,
		Format:    "EPUB",
		Targets:   []string{document.TargetSerial},
		NoArchive: true,
	})
}

func CredentialPath(home string) string {
	return filepath.Join(home, "secrets", CredentialFilename)
}

func LoadCredential(provider Provider, path string) (Client, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return provider.Load(file)
}

func SaveCredential(path string, client Client) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create Kindle secrets directory: %w", err)
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("secure Kindle secrets directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".kindle-credential-*")
	if err != nil {
		return fmt.Errorf("create temporary Kindle credential: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if err := client.Marshal(temporary); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace Kindle credential: %w", err)
	}
	return nil
}
