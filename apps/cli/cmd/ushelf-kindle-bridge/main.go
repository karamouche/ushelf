package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cyrgim/stk"
	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
)

const defaultSecretsDir = "/data/secrets"

type envelope struct {
	OK     bool         `json:"ok"`
	Result any          `json:"result,omitempty"`
	Error  *bridgeError `json:"error,omitempty"`
}

type bridgeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
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
	client, err := kindle.LoadCredential(provider, credentialPath)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 110*time.Second)
	defer cancel()

	switch args[0] {
	case "status":
		return map[string]string{
			"accountName": client.AccountName(),
			"homeRegion":  client.HomeRegion(),
			"serial":      client.Serial(),
		}, nil
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

func listDevices(ctx context.Context, client kindle.Client) (any, error) {
	devices, err := client.Devices(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"devices": devices}, nil
}

func mapError(err error) bridgeError {
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
