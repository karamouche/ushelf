// Package mcpbridge relays a local stdio MCP session to a uShelf server's
// Streamable HTTP endpoint, so agents keep launching a local command while the
// library lives wherever the server is deployed.
package mcpbridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	requestTimeout     = 10 * time.Minute
	maxResponseBytes   = 32 << 20
	jsonRPCServerError = -32000
)

type Bridge struct {
	Endpoint string
	Token    string
	HTTP     *http.Client
	// Log receives diagnostics; stdout is reserved for protocol messages.
	Log io.Writer

	writeMu         sync.Mutex
	logMu           sync.Mutex
	protocolVersion string
	versionMu       sync.RWMutex
}

type envelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Result *struct {
		ProtocolVersion string `json:"protocolVersion"`
	} `json:"result,omitempty"`
}

// Run forwards messages until stdin closes, then waits for in-flight requests.
func (b *Bridge) Run(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	if b.HTTP == nil {
		b.HTTP = &http.Client{CheckRedirect: refuseRedirect}
	}
	reader := bufio.NewReaderSize(stdin, 64*1024)
	var inFlight sync.WaitGroup
	defer inFlight.Wait()
	for {
		line, err := reader.ReadBytes('\n')
		if message := bytes.TrimSpace(line); len(message) > 0 {
			inFlight.Add(1)
			go func(message []byte) {
				defer inFlight.Done()
				b.forward(ctx, message, stdout)
			}(message)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read MCP input: %w", err)
		}
	}
}

func (b *Bridge) forward(ctx context.Context, message []byte, stdout io.Writer) {
	var request envelope
	_ = json.Unmarshal(message, &request)
	isRequest := len(request.ID) > 0 && string(request.ID) != "null" && request.Method != ""

	responses, err := b.post(ctx, message)
	if err != nil {
		b.logf("uShelf MCP %s failed: %v", request.Method, err)
		if isRequest {
			b.write(stdout, errorResponse(request.ID, err.Error()))
		}
		return
	}
	for _, response := range responses {
		if request.Method == "initialize" {
			b.rememberProtocolVersion(response)
		}
		b.write(stdout, response)
	}
}

func (b *Bridge) post(ctx context.Context, message []byte) ([][]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, b.Endpoint, bytes.NewReader(message))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Authorization", "Bearer "+b.Token)
	request.Header.Set("User-Agent", "ushelf-mcp-bridge")
	if version := b.negotiatedVersion(); version != "" {
		request.Header.Set("MCP-Protocol-Version", version)
	}
	response, err := b.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("reach uShelf: %w", err)
	}
	defer response.Body.Close()
	body := io.LimitReader(response.Body, maxResponseBytes)
	if response.StatusCode == http.StatusAccepted {
		return nil, nil
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(body)
		return nil, fmt.Errorf("uShelf returned HTTP %d: %s", response.StatusCode, describeError(raw))
	}
	if mediaType == "text/event-stream" {
		return readEventStream(body)
	}
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	return [][]byte{raw}, nil
}

// readEventStream extracts each SSE event's data payload as one JSON-RPC message.
func readEventStream(body io.Reader) ([][]byte, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), maxResponseBytes)
	var messages [][]byte
	var data []string
	flush := func() {
		if len(data) > 0 {
			messages = append(messages, []byte(strings.Join(data, "\n")))
			data = nil
		}
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
	return messages, scanner.Err()
}

func (b *Bridge) write(stdout io.Writer, message []byte) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, message); err != nil {
		b.logf("uShelf MCP returned an invalid message: %v", err)
		return
	}
	compact.WriteByte('\n')
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	if _, err := stdout.Write(compact.Bytes()); err != nil {
		b.logf("write MCP output: %v", err)
	}
}

func (b *Bridge) rememberProtocolVersion(response []byte) {
	var parsed envelope
	if json.Unmarshal(response, &parsed) == nil && parsed.Result != nil && parsed.Result.ProtocolVersion != "" {
		b.versionMu.Lock()
		b.protocolVersion = parsed.Result.ProtocolVersion
		b.versionMu.Unlock()
	}
}

func (b *Bridge) negotiatedVersion() string {
	b.versionMu.RLock()
	defer b.versionMu.RUnlock()
	return b.protocolVersion
}

func (b *Bridge) logf(format string, args ...any) {
	if b.Log == nil {
		return
	}
	b.logMu.Lock()
	defer b.logMu.Unlock()
	fmt.Fprintf(b.Log, format+"\n", args...)
}

func errorResponse(id json.RawMessage, message string) []byte {
	encoded, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": jsonRPCServerError, "message": message},
	})
	return encoded
}

func describeError(raw []byte) string {
	var payload struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(raw, &payload) == nil && payload.Error != nil {
		switch value := payload.Error.(type) {
		case string:
			return value
		case map[string]any:
			if message, ok := value["message"].(string); ok {
				return message
			}
		}
	}
	text := strings.TrimSpace(string(raw))
	if len(text) > 200 {
		text = text[:200]
	}
	return text
}

// refuseRedirect stops the token from following a redirect to another scheme or host.
// The MCP endpoint never redirects, so one means the context URL is wrong.
func refuseRedirect(request *http.Request, _ []*http.Request) error {
	return fmt.Errorf("server redirected to %s; update the context URL instead of following it with the API token", request.URL.Redacted())
}
