package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseBaseURLEnforcesTransportPolicy(t *testing.T) {
	for value, want := range map[string]string{
		"https://ushelf.example":        "https://ushelf.example/",
		"https://ushelf.example/reader": "https://ushelf.example/reader/",
		"http://127.0.0.1:43110/":       "http://127.0.0.1:43110/",
		"http://localhost:43110/reader": "http://localhost:43110/reader/",
	} {
		parsed, err := ParseBaseURL(value)
		if err != nil {
			t.Fatalf("%s: %v", value, err)
		}
		if parsed.String() != want {
			t.Errorf("%s = %s, want %s", value, parsed, want)
		}
	}
	for _, value := range []string{
		"http://ushelf.example", "ftp://ushelf.example", "https://user:pass@ushelf.example",
		"https://ushelf.example/?q=1", "ushelf.example", "",
	} {
		if _, err := ParseBaseURL(value); err == nil {
			t.Errorf("%q should be rejected", value)
		}
	}
}

func TestClientSendsTokenOnlyToAuthenticatedRoutes(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI()+" auth="+r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/reader/api/health":
			_, _ = io.WriteString(w, `{"ok":true}`)
		case "/reader/api/server":
			_, _ = io.WriteString(w, `{"version":"1.2.3"}`)
		case "/reader/api/kindle/credential":
			body, _ := io.ReadAll(r.Body)
			if r.Method == http.MethodPut && string(body) == `{"c":1}` {
				_, _ = io.WriteString(w, `{"configured":true,"accountName":"Reader"}`)
				return
			}
			_, _ = io.WriteString(w, `{"disconnected":true}`)
		}
	}))
	defer server.Close()
	client, err := New(server.URL+"/reader", "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if health, err := client.Health(ctx); err != nil || !health.OK {
		t.Fatalf("health = %#v, %v", health, err)
	}
	if info, err := client.Server(ctx); err != nil || info.Version != "1.2.3" {
		t.Fatalf("server = %#v, %v", info, err)
	}
	if status, err := client.KindleConnect(ctx, []byte(`{"c":1}`)); err != nil || status.AccountName != "Reader" {
		t.Fatalf("connect = %#v, %v", status, err)
	}
	if err := client.KindleDisconnect(ctx, true); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"GET /reader/api/health auth=",
		"GET /reader/api/server auth=Bearer secret-token",
		"PUT /reader/api/kindle/credential auth=Bearer secret-token",
		"DELETE /reader/api/kindle/credential?deregister=true auth=Bearer secret-token",
	}
	if strings.Join(seen, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests:\n%s", strings.Join(seen, "\n"))
	}
	if client.Endpoint("mcp") != server.URL+"/reader/mcp" {
		t.Fatalf("endpoint = %s", client.Endpoint("mcp"))
	}
}

func TestClientReportsServerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"Invalid API token"}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, "wrong")
	_, err := client.Server(context.Background())
	if !IsUnauthorized(err) || !strings.Contains(err.Error(), "Invalid API token") {
		t.Fatalf("err = %v", err)
	}
}

func TestClientRefusesRedirectsWithTheToken(t *testing.T) {
	var leaked bool
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		leaked = leaked || r.Header.Get("Authorization") != ""
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client, _ := New(server.URL, "secret-token")
	_, err := client.Server(context.Background())
	if err == nil || !strings.Contains(err.Error(), "redirected") || leaked {
		t.Fatalf("err = %v, leaked = %v", err, leaked)
	}
}
