// Package api is the CLI's HTTP client for a uShelf server, wherever it is deployed.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBytes = 8 << 20

// Error is a non-success response from the server.
type Error struct {
	Status  int
	Message string
	Code    string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("server returned HTTP %d", e.Status)
	}
	return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
}

// IsUnauthorized reports whether the server rejected the API token.
func IsUnauthorized(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized
}

type Client struct {
	base  *url.URL
	token string
	http  *http.Client
}

// New validates baseURL and returns a client. Tokens are only ever sent over HTTPS,
// except to loopback addresses where traffic never leaves the machine.
func New(baseURL, token string) (*Client, error) {
	parsed, err := ParseBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	return &Client{base: parsed, token: token, http: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: refuseRedirect}}, nil
}

// refuseRedirect stops the token from following a redirect to another scheme or host.
// The server never redirects API requests, so one means the context URL is wrong.
func refuseRedirect(request *http.Request, _ []*http.Request) error {
	return fmt.Errorf("server redirected to %s; update the context URL instead of following it with the API token", request.URL.Redacted())
}

// ParseBaseURL normalizes a server URL and enforces the transport policy.
func ParseBaseURL(value string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("server URL must be an absolute http(s) URL without credentials, query, or fragment")
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		if !IsLoopbackHost(parsed.Hostname()) {
			return nil, fmt.Errorf("server URL %s must use https unless it points to this machine", value)
		}
	default:
		return nil, fmt.Errorf("server URL must use http or https")
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	return parsed, nil
}

func IsLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (c *Client) BaseURL() string { return c.base.String() }

// Endpoint resolves a path relative to the server base path.
func (c *Client) Endpoint(path string) string {
	return c.base.ResolveReference(&url.URL{Path: strings.TrimPrefix(path, "/")}).String()
}

func (c *Client) Token() string { return c.token }

type Health struct {
	OK           bool `json:"ok"`
	AuthRequired bool `json:"authRequired"`
}

// Health calls the public, content-free health check.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var health Health
	err := c.do(ctx, http.MethodGet, "api/health", nil, "", false, &health)
	return health, err
}

type ServerInfo struct {
	Version string `json:"version"`
}

// Server verifies the API token and returns the server version.
func (c *Client) Server(ctx context.Context) (ServerInfo, error) {
	var info ServerInfo
	err := c.do(ctx, http.MethodGet, "api/server", nil, "", true, &info)
	return info, err
}

type SkillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type Skill struct {
	Name  string      `json:"name"`
	Files []SkillFile `json:"files"`
}

type SkillBundle struct {
	Version string  `json:"version"`
	Skills  []Skill `json:"skills"`
}

func (c *Client) Skills(ctx context.Context) (SkillBundle, error) {
	var bundle SkillBundle
	err := c.do(ctx, http.MethodGet, "api/agent/skills", nil, "", true, &bundle)
	return bundle, err
}

type KindleStatus struct {
	Configured  bool   `json:"configured"`
	AccountName string `json:"accountName"`
	HomeRegion  string `json:"homeRegion"`
	Error       *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type KindleDevice struct {
	Name   string `json:"name"`
	Serial string `json:"serial"`
}

func (c *Client) KindleStatus(ctx context.Context) (KindleStatus, error) {
	var status KindleStatus
	err := c.do(ctx, http.MethodGet, "api/kindle/status", nil, "", true, &status)
	return status, err
}

func (c *Client) KindleDevices(ctx context.Context) ([]KindleDevice, error) {
	var result struct {
		Devices []KindleDevice `json:"devices"`
	}
	err := c.do(ctx, http.MethodGet, "api/kindle/devices", nil, "", true, &result)
	return result.Devices, err
}

// KindleConnect uploads a credential registered with Amazon on this machine.
func (c *Client) KindleConnect(ctx context.Context, credential []byte) (KindleStatus, error) {
	var status KindleStatus
	err := c.do(ctx, http.MethodPut, "api/kindle/credential", bytes.NewReader(credential), "application/json", true, &status)
	return status, err
}

func (c *Client) KindleDisconnect(ctx context.Context, deregister bool) error {
	path := fmt.Sprintf("api/kindle/credential?deregister=%t", deregister)
	return c.do(ctx, http.MethodDelete, path, nil, "", true, nil)
}

// Connector is a remote MCP client, such as Claude or ChatGPT, authorized through OAuth.
type Connector struct {
	ClientID     string    `json:"clientId"`
	ClientName   string    `json:"clientName"`
	RedirectURIs []string  `json:"redirectUris"`
	ConnectedAt  time.Time `json:"connectedAt"`
	LastUsedAt   time.Time `json:"lastUsedAt"`
}

func (c *Client) Connectors(ctx context.Context) ([]Connector, error) {
	var result struct {
		Connectors []Connector `json:"connectors"`
	}
	err := c.do(ctx, http.MethodGet, "api/connectors", nil, "", true, &result)
	return result.Connectors, err
}

// RevokeConnector deletes one connector's registration and tokens.
func (c *Client) RevokeConnector(ctx context.Context, clientID string) error {
	return c.do(ctx, http.MethodDelete, "api/connectors/"+url.PathEscape(clientID), nil, "", true, nil)
}

// RevokeAllConnectors deletes every connector and returns how many were connected.
func (c *Client) RevokeAllConnectors(ctx context.Context) (int, error) {
	var result struct {
		Revoked int `json:"revoked"`
	}
	err := c.do(ctx, http.MethodDelete, "api/connectors", nil, "", true, &result)
	return result.Revoked, err
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, contentType string, authenticated bool, target any) error {
	reference, err := url.Parse(path)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base.ResolveReference(reference).String(), body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "ushelf-cli")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if authenticated {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("reach uShelf at %s: %w", c.base, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read uShelf response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		apiErr := &Error{Status: response.StatusCode}
		var payload struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if json.Unmarshal(raw, &payload) == nil {
			apiErr.Message, apiErr.Code = payload.Error, payload.Code
		}
		return apiErr
	}
	if target == nil {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("parse uShelf response from %s: %w", path, err)
	}
	return nil
}
