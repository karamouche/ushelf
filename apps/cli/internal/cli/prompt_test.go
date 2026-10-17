package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestPromptSecretFromPipedInput(t *testing.T) {
	value, err := promptSecret(strings.NewReader("hunter22\nhunter22\n"), &bytes.Buffer{}, "App password", true)
	if err != nil || value != "hunter22" {
		t.Fatalf("value = %q, err = %v", value, err)
	}
	for _, input := range []string{"a\nb\n", "\n\n", ""} {
		if _, err := promptSecret(strings.NewReader(input), &bytes.Buffer{}, "App password", true); err == nil {
			t.Errorf("input %q should be rejected", input)
		}
	}
	if value, err := promptSecret(strings.NewReader("token"), &bytes.Buffer{}, "API token", false); err != nil || value != "token" {
		t.Fatalf("single entry = %q, %v", value, err)
	}
}
