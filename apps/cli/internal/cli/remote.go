package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const remoteScopes = "ushelf:read ushelf:write ushelf:kindle offline_access"

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type remoteCredentials struct {
	ServerURL          string `json:"serverUrl"`
	ClientID           string `json:"clientId"`
	ClientSecret       string `json:"clientSecret,omitempty"`
	AccessToken        string `json:"accessToken"`
	RefreshToken       string `json:"refreshToken"`
	TokenEndpoint      string `json:"tokenEndpoint"`
	RevocationEndpoint string `json:"revocationEndpoint"`
	ExpiresAt          string `json:"expiresAt"`
	Scope              string `json:"scope"`
}

type protectedResourceMetadata struct {
	AuthorizationServers []string `json:"authorization_servers"`
}

type authorizationMetadata struct {
	DeviceEndpoint       string `json:"device_authorization_endpoint"`
	TokenEndpoint        string `json:"token_endpoint"`
	RegistrationEndpoint string `json:"registration_endpoint"`
	RevocationEndpoint   string `json:"revocation_endpoint"`
}

func (s *commandState) httpClient() HTTPClient {
	if s.deps.HTTPClient != nil {
		return s.deps.HTTPClient
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func normalizeRemoteURL(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("remote URL must be a credential-free HTTPS origin")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func (s *commandState) connectRemote(ctx context.Context, value string) error {
	serverURL, err := normalizeRemoteURL(value)
	if err != nil {
		return err
	}
	var resource protectedResourceMetadata
	if err := s.getJSON(ctx, serverURL+"/.well-known/oauth-protected-resource/mcp", &resource); err != nil {
		return fmt.Errorf("discover remote uShelf: %w", err)
	}
	if len(resource.AuthorizationServers) != 1 {
		return errors.New("remote uShelf returned invalid authorization metadata")
	}
	var metadata authorizationMetadata
	if err := s.getJSON(ctx, strings.TrimSuffix(resource.AuthorizationServers[0], "/")+"/.well-known/oauth-authorization-server", &metadata); err != nil {
		return fmt.Errorf("discover OAuth server: %w", err)
	}
	if metadata.DeviceEndpoint == "" || metadata.TokenEndpoint == "" || metadata.RegistrationEndpoint == "" {
		return errors.New("remote uShelf does not advertise device authorization and registration")
	}

	registrationBody, _ := json.Marshal(map[string]any{
		"client_name":                "uShelf CLI",
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"urn:ietf:params:oauth:grant-type:device_code", "refresh_token"},
		"response_types":             []string{"code"},
		"scope":                      remoteScopes,
	})
	var registration struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := s.postJSON(ctx, metadata.RegistrationEndpoint, registrationBody, &registration); err != nil {
		return fmt.Errorf("register uShelf CLI: %w", err)
	}
	deviceForm := url.Values{
		"client_id": {registration.ClientID},
		"scope":     {remoteScopes},
		"resource":  {serverURL + "/mcp"},
	}
	var device struct {
		DeviceCode           string `json:"device_code"`
		UserCode             string `json:"user_code"`
		VerificationURI      string `json:"verification_uri"`
		VerificationComplete string `json:"verification_uri_complete"`
		ExpiresIn            int    `json:"expires_in"`
		Interval             int    `json:"interval"`
	}
	if err := s.postForm(ctx, metadata.DeviceEndpoint, deviceForm, &device); err != nil {
		return fmt.Errorf("start device authorization: %w", err)
	}
	verificationURL := device.VerificationComplete
	if verificationURL == "" {
		verificationURL = device.VerificationURI
	}
	fmt.Fprintf(s.deps.Stdout, "Open %s and approve code %s\n", verificationURL, device.UserCode)
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	_ = s.deps.Runner.Run(ctx, nil, io.Discard, io.Discard, opener, verificationURL)

	interval := time.Duration(max(device.Interval, 5)) * time.Second
	deadline := time.Now().Add(time.Duration(max(device.ExpiresIn, 600)) * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		token, pending, tokenErr := s.pollDeviceToken(ctx, metadata.TokenEndpoint, registration.ClientID, registration.ClientSecret, device.DeviceCode)
		if pending {
			continue
		}
		if tokenErr != nil {
			return tokenErr
		}
		credentials := remoteCredentials{
			ServerURL: serverURL, ClientID: registration.ClientID, ClientSecret: registration.ClientSecret,
			AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, TokenEndpoint: metadata.TokenEndpoint,
			RevocationEndpoint: metadata.RevocationEndpoint, ExpiresAt: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC().Format(time.RFC3339), Scope: token.Scope,
		}
		if err := saveRemoteCredentials(s.settings.Home, credentials); err != nil {
			return err
		}
		config, err := readFileConfig(s.settings.ConfigPath)
		if err != nil {
			return err
		}
		config.RemoteURL, config.ActiveTarget = serverURL, "remote"
		if err := writeFileConfig(s.settings.ConfigPath, config); err != nil {
			return err
		}
		fmt.Fprintf(s.deps.Stdout, "Connected to %s and selected the remote target.\n", serverURL)
		return nil
	}
	return errors.New("device authorization expired before approval")
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (s *commandState) pollDeviceToken(ctx context.Context, endpoint, clientID, clientSecret, deviceCode string) (tokenResponse, bool, error) {
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {deviceCode}, "client_id": {clientID}}
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	var token tokenResponse
	status, raw, err := s.doForm(ctx, endpoint, form)
	if err != nil {
		return token, false, err
	}
	if status >= 200 && status < 300 {
		if err := json.Unmarshal(raw, &token); err != nil {
			return token, false, err
		}
		return token, false, nil
	}
	var failure struct {
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	_ = json.Unmarshal(raw, &failure)
	if failure.Error == "authorization_pending" || failure.Error == "slow_down" {
		return token, true, nil
	}
	return token, false, fmt.Errorf("device authorization failed: %s", firstNonEmpty(failure.Description, failure.Error))
}

func (s *commandState) disconnectRemote(ctx context.Context) error {
	credentials, err := loadRemoteCredentials(s.settings.Home)
	if err != nil {
		return err
	}
	if credentials.RevocationEndpoint != "" {
		form := url.Values{"token": {credentials.RefreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {credentials.ClientID}}
		if credentials.ClientSecret != "" {
			form.Set("client_secret", credentials.ClientSecret)
		}
		status, raw, err := s.doForm(ctx, credentials.RevocationEndpoint, form)
		if err != nil {
			return fmt.Errorf("revoke remote grant: %w", err)
		}
		if status < 200 || status >= 300 {
			return fmt.Errorf("revoke remote grant: HTTP %d: %s", status, strings.TrimSpace(string(raw)))
		}
	}
	if err := os.Remove(remoteCredentialsPath(s.settings.Home)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	config, err := readFileConfig(s.settings.ConfigPath)
	if err != nil {
		return err
	}
	config.ActiveTarget = "local"
	if err := writeFileConfig(s.settings.ConfigPath, config); err != nil {
		return err
	}
	fmt.Fprintln(s.deps.Stdout, "Remote grant revoked; local target selected.")
	return nil
}

func (s *commandState) getJSON(ctx context.Context, endpoint string, output any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	return s.doJSON(req, output)
}

func (s *commandState) postJSON(ctx context.Context, endpoint string, body []byte, output any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	return s.doJSON(req, output)
}

func (s *commandState) postForm(ctx context.Context, endpoint string, form url.Values, output any) error {
	status, raw, err := s.doForm(ctx, endpoint, form)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("HTTP %d: %s", status, strings.TrimSpace(string(raw)))
	}
	return json.Unmarshal(raw, output)
}

func (s *commandState) doForm(ctx context.Context, endpoint string, form url.Values) (int, []byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	response, err := s.httpClient().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, raw, err
}

func (s *commandState) doJSON(request *http.Request, output any) error {
	response, err := s.httpClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}

func remoteCredentialsPath(home string) string {
	return filepath.Join(home, "credentials", "remote.json")
}

func saveRemoteCredentials(home string, credentials remoteCredentials) error {
	directory := filepath.Dir(remoteCredentialsPath(home))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(credentials, "", "  ")
	return atomicWrite(remoteCredentialsPath(home), append(raw, '\n'), 0o600)
}

func loadRemoteCredentials(home string) (remoteCredentials, error) {
	var credentials remoteCredentials
	raw, err := os.ReadFile(remoteCredentialsPath(home))
	if errors.Is(err, os.ErrNotExist) {
		return credentials, errors.New("remote credentials are missing; run `ushelf connect URL`")
	}
	if err != nil {
		return credentials, err
	}
	if err := json.Unmarshal(raw, &credentials); err != nil {
		return credentials, fmt.Errorf("parse remote credentials: %w", err)
	}
	return credentials, nil
}
