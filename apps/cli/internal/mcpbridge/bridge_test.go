package mcpbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
)

type recorded struct {
	auth, accept, version, body string
}

func TestBridgeRelaysJSONAndEventStreamResponses(t *testing.T) {
	var mu sync.Mutex
	var requests []recorded
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, recorded{r.Header.Get("Authorization"), r.Header.Get("Accept"), r.Header.Get("MCP-Protocol-Version"), string(body)})
		mu.Unlock()
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal(body, &message)
		switch message.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}`)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":2,\"result\":{\"tools\":[]}}\n\n")
		}
	}))
	defer server.Close()

	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		"",
	}, "\n")
	bridge := &Bridge{Endpoint: server.URL + "/mcp", Token: "secret"}
	var stdout bytes.Buffer
	if err := bridge.Run(context.Background(), strings.NewReader(input), &stdout); err != nil {
		t.Fatal(err)
	}
	if err := bridge.Run(context.Background(), strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`), &stdout); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	sort.Strings(lines)
	want := []string{
		`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}`,
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("stdout:\n%s", stdout.String())
	}
	for _, request := range requests {
		if request.auth != "Bearer secret" || request.accept != "application/json, text/event-stream" {
			t.Fatalf("headers = %#v", request)
		}
	}
	last := requests[len(requests)-1]
	if !strings.Contains(last.body, "tools/list") || last.version != "2025-06-18" {
		t.Fatalf("protocol version not negotiated: %#v", last)
	}
}

func TestBridgeAnswersRequestsWhenTheServerFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"Invalid API token"}`)
	}))
	defer server.Close()
	var stdout, log bytes.Buffer
	bridge := &Bridge{Endpoint: server.URL, Token: "wrong", Log: &log}
	input := `{"jsonrpc":"2.0","id":"a","method":"tools/call"}` + "\n" + `{"jsonrpc":"2.0","method":"notifications/cancelled"}` + "\n"
	if err := bridge.Run(context.Background(), strings.NewReader(input), &stdout); err != nil {
		t.Fatal(err)
	}
	var response struct {
		ID    string `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &response); err != nil {
		t.Fatalf("stdout must contain exactly one JSON-RPC error: %q", stdout.String())
	}
	if response.ID != "a" || response.Error.Code != jsonRPCServerError || !strings.Contains(response.Error.Message, "Invalid API token") {
		t.Fatalf("response = %#v", response)
	}
	if !strings.Contains(log.String(), "notifications/cancelled") {
		t.Fatalf("expected diagnostics on the log stream, got %q", log.String())
	}
}

func TestBridgeRefusesRedirectsWithTheToken(t *testing.T) {
	var leaked bool
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		leaked = leaked || r.Header.Get("Authorization") != ""
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusPermanentRedirect)
	}))
	defer server.Close()
	var stdout, log bytes.Buffer
	bridge := &Bridge{Endpoint: server.URL, Token: "secret-token", Log: &log}
	input := `{"jsonrpc":"2.0","id":"a","method":"tools/call"}` + "\n"
	if err := bridge.Run(context.Background(), strings.NewReader(input), &stdout); err != nil {
		t.Fatal(err)
	}
	if leaked || !strings.Contains(stdout.String(), "redirected") {
		t.Fatalf("leaked = %v, stdout = %q", leaked, stdout.String())
	}
}
