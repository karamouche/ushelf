package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

type fakeCall struct {
	name    string
	args    []string
	stdin   string
	envFile string
	stdout  io.Writer
	stderr  io.Writer
}

func (c fakeCall) joined() string { return strings.Join(c.args, " ") }

// scriptRunner answers each command through a handler, so tests describe behavior
// by command shape instead of by call order.
type scriptRunner struct {
	mu      sync.Mutex
	handler func(call fakeCall) (string, error)
	calls   []fakeCall
}

func (r *scriptRunner) record(name string, args []string, stdin io.Reader, stdout, stderr io.Writer) fakeCall {
	call := fakeCall{name: name, args: append([]string(nil), args...), stdout: stdout, stderr: stderr}
	if stdin != nil {
		raw, _ := io.ReadAll(stdin)
		call.stdin = string(raw)
	}
	for index, arg := range args {
		if arg == "--env-file" && index+1 < len(args) {
			raw, _ := os.ReadFile(args[index+1])
			call.envFile = string(raw)
		}
	}
	r.mu.Lock()
	r.calls = append(r.calls, call)
	r.mu.Unlock()
	return call
}

func (r *scriptRunner) answer(call fakeCall) (string, error) {
	if r.handler == nil {
		return "", nil
	}
	return r.handler(call)
}

func (r *scriptRunner) Run(_ context.Context, stdin io.Reader, stdout, stderr io.Writer, name string, args ...string) error {
	call := r.record(name, args, stdin, stdout, stderr)
	output, err := r.answer(call)
	if stdout != nil {
		_, _ = io.WriteString(stdout, output)
	}
	return err
}

func (r *scriptRunner) Output(_ context.Context, name string, args ...string) (string, error) {
	return r.answer(r.record(name, args, nil, nil, nil))
}

func (r *scriptRunner) find(predicate func(fakeCall) bool) []fakeCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	var matches []fakeCall
	for _, call := range r.calls {
		if predicate(call) {
			matches = append(matches, call)
		}
	}
	return matches
}

// dockerArgs strips the remote --host prefix so handlers match on the Docker subcommand.
func dockerArgs(call fakeCall) []string {
	if len(call.args) >= 2 && call.args[0] == "--host" {
		return call.args[2:]
	}
	return call.args
}

func hasPrefix(args []string, prefix ...string) bool {
	if len(args) < len(prefix) {
		return false
	}
	for index, value := range prefix {
		if args[index] != value {
			return false
		}
	}
	return true
}

// freshDocker simulates a daemon with the image present and no uShelf containers.
func freshDocker(call fakeCall) (string, error) {
	args := dockerArgs(call)
	switch {
	case hasPrefix(args, "inspect", "--format"):
		return "healthy", nil
	case hasPrefix(args, "run", "-d"):
		return "6b88fef57f44\n", nil
	}
	return "", nil
}

// fakeServer is a minimal uShelf API that records the bearer token it receives.
type fakeServer struct {
	*httptest.Server
	mu       sync.Mutex
	tokens   []string
	requests []string
	bodies   map[string]string
	routes   map[string]func(http.ResponseWriter, *http.Request)
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	server := &fakeServer{bodies: map[string]string{}, routes: map[string]func(http.ResponseWriter, *http.Request){}}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		key := r.Method + " " + r.URL.Path
		server.mu.Lock()
		server.tokens = append(server.tokens, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		server.requests = append(server.requests, r.Method+" "+r.URL.RequestURI())
		server.bodies[key] = string(body)
		route := server.routes[key]
		server.mu.Unlock()
		if route != nil {
			r.Body = io.NopCloser(bytes.NewReader(body))
			route(w, r)
			return
		}
		switch key {
		case "GET /api/health":
			respondJSON(w, map[string]any{"ok": true})
		case "GET /api/server":
			respondJSON(w, map[string]any{"version": "9.9.9"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func (s *fakeServer) handle(key string, handler func(http.ResponseWriter, *http.Request)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.routes[key] = handler
}

func respondJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

type testCLI struct {
	home   string
	runner *scriptRunner
	stdin  *bytes.Buffer
	stdout *bytes.Buffer
	stderr *bytes.Buffer
	deps   Dependencies
}

func newTestCLI(t *testing.T) *testCLI {
	t.Helper()
	t.Setenv("USHELF_CONTEXT", "")
	t.Setenv("USHELF_APP_PASSWORD", "")
	t.Setenv("USHELF_API_TOKEN", "")
	cli := &testCLI{home: t.TempDir(), runner: &scriptRunner{handler: freshDocker}, stdin: &bytes.Buffer{}, stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}}
	cli.deps = Dependencies{Runner: cli.runner, Stdin: cli.stdin, Stdout: cli.stdout, Stderr: cli.stderr}
	return cli
}

func (c *testCLI) run(args ...string) error {
	root := NewRootCommand(c.deps, BuildInfo{Version: "1.2.3", Commit: "test", BuildDate: "today"})
	root.SetArgs(append([]string{"--home", c.home}, args...))
	return root.Execute()
}

func (c *testCLI) store() Store { return Store{Home: c.home} }

// addContext writes a context directly, bypassing deployment.
func (c *testCLI) addContext(t *testing.T, name string, spec ContextSpec, credentials Credentials) {
	t.Helper()
	config, err := c.store().Load()
	if err != nil {
		t.Fatal(err)
	}
	config.Contexts[name] = spec
	config.CurrentContext = name
	if err := c.store().Save(config); err != nil {
		t.Fatal(err)
	}
	all, err := c.store().LoadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	all[name] = credentials
	if err := c.store().SaveCredentials(all); err != nil {
		t.Fatal(err)
	}
}
