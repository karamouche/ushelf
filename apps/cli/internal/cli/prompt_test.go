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

func TestAppPasswordsMustBeAtLeastTwelveCharacters(t *testing.T) {
	for _, value := range []string{"", "short", "elevenchars", "ünicodeünic"} {
		if err := validateAppPassword(value); err == nil {
			t.Errorf("%q should be rejected", value)
		}
	}
	for _, value := range []string{"twelve-chars", "ünicodeünicö", "a much longer passphrase"} {
		if err := validateAppPassword(value); err != nil {
			t.Errorf("%q should be accepted: %v", value, err)
		}
	}
	if _, err := promptAppPassword(strings.NewReader("hunter22\nhunter22\n"), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "at least 12") {
		t.Fatalf("short prompted password: %v", err)
	}
	if value, err := promptAppPassword(strings.NewReader("correct horse\ncorrect horse\n"), &bytes.Buffer{}); err != nil || value != "correct horse" {
		t.Fatalf("value = %q, err = %v", value, err)
	}
}
