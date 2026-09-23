package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (s *commandState) remoteMCP(ctx context.Context) error {
	credentials, err := loadRemoteCredentials(s.settings.Home)
	if err != nil {
		return err
	}
	authorized := &remoteTokenTransport{state: s, credentials: &credentials, base: http.DefaultTransport}
	client := mcp.NewClient(&mcp.Implementation{Name: "ushelf-cli-bridge", Version: s.build.Version}, nil)
	remote, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   strings.TrimSuffix(credentials.ServerURL, "/") + "/mcp",
		HTTPClient: &http.Client{Transport: authorized},
	}, nil)
	if err != nil {
		return fmt.Errorf("connect remote MCP: %w", err)
	}
	defer remote.Close()

	server := mcp.NewServer(
		&mcp.Implementation{Name: "ushelf", Version: s.build.Version},
		&mcp.ServerOptions{Instructions: "uShelf is the owner's personal read-later library. Permanent deletion requires request_delete followed by confirm_delete."},
	)
	tools, err := remote.ListTools(ctx, nil)
	if err != nil {
		return fmt.Errorf("list remote MCP tools: %w", err)
	}
	for _, remoteTool := range tools.Tools {
		tool := remoteTool
		server.AddTool(tool, func(callCtx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var arguments any
			if len(request.Params.Arguments) > 0 {
				if err := json.Unmarshal(request.Params.Arguments, &arguments); err != nil {
					return nil, err
				}
			}
			return remote.CallTool(callCtx, &mcp.CallToolParams{Name: tool.Name, Arguments: arguments})
		})
	}
	templates, err := remote.ListResourceTemplates(ctx, nil)
	if err != nil {
		return fmt.Errorf("list remote MCP resources: %w", err)
	}
	for _, remoteTemplate := range templates.ResourceTemplates {
		template := remoteTemplate
		server.AddResourceTemplate(template, func(readCtx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return remote.ReadResource(readCtx, &mcp.ReadResourceParams{URI: request.Params.URI})
		})
	}
	return server.Run(ctx, &mcp.StdioTransport{})
}

type remoteTokenTransport struct {
	state       *commandState
	credentials *remoteCredentials
	base        http.RoundTripper
	mu          sync.Mutex
}

func (t *remoteTokenTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if err := t.ensureToken(request.Context()); err != nil {
		return nil, err
	}
	clone := request.Clone(request.Context())
	clone.Header.Set("authorization", "Bearer "+t.credentials.AccessToken)
	return t.base.RoundTrip(clone)
}

func (t *remoteTokenTransport) ensureToken(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	expiresAt, _ := time.Parse(time.RFC3339, t.credentials.ExpiresAt)
	if t.credentials.AccessToken != "" && time.Until(expiresAt) > time.Minute {
		return nil
	}
	if t.credentials.RefreshToken == "" {
		return fmt.Errorf("remote access expired; run `ushelf connect %s` again", t.credentials.ServerURL)
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {t.credentials.RefreshToken},
		"client_id":     {t.credentials.ClientID},
	}
	if t.credentials.ClientSecret != "" {
		form.Set("client_secret", t.credentials.ClientSecret)
	}
	status, raw, err := t.state.doForm(ctx, t.credentials.TokenEndpoint, form)
	if err != nil {
		return fmt.Errorf("refresh remote access: %w", err)
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("refresh remote access: HTTP %d: %s", status, strings.TrimSpace(string(raw)))
	}
	var token tokenResponse
	if err := json.Unmarshal(raw, &token); err != nil {
		return fmt.Errorf("parse refreshed access: %w", err)
	}
	t.credentials.AccessToken = token.AccessToken
	if token.RefreshToken != "" {
		t.credentials.RefreshToken = token.RefreshToken
	}
	t.credentials.ExpiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC().Format(time.RFC3339)
	if token.Scope != "" {
		t.credentials.Scope = token.Scope
	}
	return saveRemoteCredentials(t.state.settings.Home, *t.credentials)
}
