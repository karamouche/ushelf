package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/cyrgim/stk"
	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
)

const (
	defaultSecretsDir  = "/data/secrets"
	maxCredentialBytes = 64 * 1024
)

var errAlreadyConfigured = errors.New("kindle is already configured")

type envelope struct {
	OK     bool         `json:"ok"`
	Result any          `json:"result,omitempty"`
	Error  *bridgeError `json:"error,omitempty"`
}

type bridgeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type disconnectInput struct {
	Deregister bool `json:"deregister"`
}

type sendInput struct {
	Path         string `json:"path"`
	Size         int64  `json:"size"`
	Title        string `json:"title"`
	Author       string `json:"author"`
	TargetSerial string `json:"targetSerial"`
}

func main() {
	result, err := run(os.Args[1:], os.Stdin, kindle.STKProvider{})
	response := envelope{OK: err == nil, Result: result}
	if err != nil {
		mapped := mapError(err)
		response.Result = nil
		response.Error = &mapped
	}
	if encodeErr := json.NewEncoder(os.Stdout).Encode(response); encodeErr != nil {
		fmt.Fprintln(os.Stderr, "kindle bridge: could not encode response")
		os.Exit(2)
	}
}

func run(args []string, input io.Reader, provider kindle.Provider) (any, error) {
	if len(args) != 1 {
		return nil, errors.New("invalid bridge command")
	}
	secretsDir := os.Getenv("USHELF_SECRETS_DIR")
	if secretsDir == "" {
		secretsDir = defaultSecretsDir
	}
	credentialPath := filepath.Join(secretsDir, kindle.CredentialFilename)
	ctx, cancel := context.WithTimeout(context.Background(), kindle.OperationTimeout)
	defer cancel()

	switch args[0] {
	case "connect":
		return connect(credentialPath, input, provider)
	case "disconnect":
		return disconnect(ctx, credentialPath, input, provider)
	}

	client, err := kindle.LoadCredential(provider, credentialPath)
	if err != nil {
		return nil, err
	}
	switch args[0] {
	case "status":
		return statusOf(client), nil
	case "devices":
		return listDevices(ctx, client)
	case "send":
		var request sendInput
		decoder := json.NewDecoder(io.LimitReader(input, 64*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			return nil, errors.New("invalid send request")
		}
		if request.Path == "" || request.Size <= 0 || strings.TrimSpace(request.Title) == "" || request.TargetSerial == "" {
			return nil, errors.New("invalid send request")
		}
		devices, err := client.Devices(ctx)
		if err != nil {
			return nil, err
		}
		matched := false
		for _, device := range devices {
			if device.Serial == request.TargetSerial {
				matched = true
				break
			}
		}
		if !matched {
			return nil, errors.New("selected Kindle device was not found")
		}
		file, err := os.Open(request.Path)
		if err != nil {
			return nil, errors.New("generated Kindle document is unavailable")
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() != request.Size {
			return nil, errors.New("generated Kindle document is invalid")
		}
		sku, err := client.Send(ctx, kindle.Document{
			Content: file, Size: request.Size, Title: request.Title,
			Author: request.Author, TargetSerial: request.TargetSerial,
		})
		if err != nil {
			return nil, err
		}
		return map[string]string{"sku": sku}, nil
	default:
		return nil, errors.New("invalid bridge command")
	}
}

// connect stores a credential registered elsewhere, such as by the CLI on the user's machine.
func connect(credentialPath string, input io.Reader, provider kindle.Provider) (any, error) {
	if _, err := os.Stat(credentialPath); err == nil {
		return nil, errAlreadyConfigured
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(input, maxCredentialBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maxCredentialBytes {
		return nil, errors.New("invalid credential upload")
	}
	client, err := provider.Load(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("load uploaded credential: %w", err)
	}
	if err := kindle.SaveCredential(credentialPath, client); err != nil {
		return nil, err
	}
	return statusOf(client), nil
}

func disconnect(ctx context.Context, credentialPath string, input io.Reader, provider kindle.Provider) (any, error) {
	var request disconnectInput
	decoder := json.NewDecoder(io.LimitReader(input, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return nil, errors.New("invalid disconnect request")
	}
	client, err := kindle.LoadCredential(provider, credentialPath)
	if errors.Is(err, os.ErrNotExist) || err != nil && request.Deregister {
		return nil, err
	}
	if request.Deregister {
		if err := client.Deregister(ctx); err != nil {
			return nil, err
		}
	}
	if err := os.Remove(credentialPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return map[string]bool{"disconnected": true}, nil
}

func statusOf(client kindle.Client) map[string]string {
	return map[string]string{
		"accountName": client.AccountName(),
		"homeRegion":  client.HomeRegion(),
		"serial":      client.Serial(),
	}
}

func listDevices(ctx context.Context, client kindle.Client) (any, error) {
	devices, err := client.Devices(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"devices": devices}, nil
}

func mapError(err error) bridgeError {
	if errors.Is(err, errAlreadyConfigured) {
		return bridgeError{Code: "already_configured", Message: "Kindle is already connected. Disconnect it before connecting another account."}
	}
	if errors.Is(err, os.ErrNotExist) {
		return bridgeError{Code: "not_configured", Message: "Run `ushelf kindle setup` to connect Kindle."}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return bridgeError{Code: "timeout", Message: "Amazon did not respond in time. The delivery result is unknown; do not retry automatically."}
	}
	var apiError *stk.APIError
	if errors.As(err, &apiError) {
		if apiError.Status == 401 || apiError.Status == 403 {
			return bridgeError{Code: "credential_invalid", Message: "The Kindle credential is no longer valid. Reconnect with the uShelf CLI."}
		}
		if apiError.Path == "/GetUploadUrl" || apiError.Path == "/SendToKindle" {
			return bridgeError{Code: "upload_rejected", Message: "Amazon rejected the Kindle upload."}
		}
		return bridgeError{Code: "amazon_unavailable", Message: "Amazon Send to Kindle is currently unavailable."}
	}
	message := err.Error()
	if strings.Contains(message, "credential") || strings.Contains(message, "private key") {
		return bridgeError{Code: "credential_invalid", Message: "The Kindle credential could not be loaded. Reconnect with the uShelf CLI."}
	}
	if strings.Contains(message, "selected Kindle device") {
		return bridgeError{Code: "device_not_found", Message: message}
	}
	if strings.Contains(message, "invalid") || strings.Contains(message, "unavailable") {
		return bridgeError{Code: "invalid_request", Message: message}
	}
	return bridgeError{Code: "amazon_unavailable", Message: "Amazon Send to Kindle is currently unavailable."}
}
