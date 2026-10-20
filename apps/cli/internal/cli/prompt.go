package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/term"
)

// minAppPasswordLength is the shortest app password the CLI will configure. The password is the
// only credential guarding the remote reader and connector consent, so it must resist guessing.
const minAppPasswordLength = 12

// validateAppPassword rejects app passwords too short to withstand online guessing.
func validateAppPassword(value string) error {
	if utf8.RuneCountInString(value) < minAppPasswordLength {
		return fmt.Errorf("app password must be at least %d characters", minAppPasswordLength)
	}
	return nil
}

// promptAppPassword prompts twice for a new app password and enforces the minimum length.
func promptAppPassword(input io.Reader, output io.Writer) (string, error) {
	value, err := promptSecret(input, output, "App password", true)
	if err != nil {
		return "", err
	}
	if err := validateAppPassword(value); err != nil {
		return "", err
	}
	return value, nil
}

// promptSecret reads a secret without echo on a terminal, or line by line from piped input.
func promptSecret(input io.Reader, output io.Writer, label string, confirm bool) (string, error) {
	var read func(prompt string) (string, error)
	if file, ok := input.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		read = func(prompt string) (string, error) {
			if _, err := fmt.Fprint(output, prompt); err != nil {
				return "", err
			}
			value, err := term.ReadPassword(int(file.Fd()))
			fmt.Fprintln(output)
			return string(value), err
		}
	} else {
		reader := bufio.NewReader(input)
		read = func(string) (string, error) {
			value, err := reader.ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return "", err
			}
			if value == "" {
				return "", fmt.Errorf("%s: %w", strings.ToLower(label), io.ErrUnexpectedEOF)
			}
			return strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r"), nil
		}
	}
	first, err := read(label + ": ")
	if err != nil {
		return "", err
	}
	if first == "" {
		return "", fmt.Errorf("%s cannot be empty", strings.ToLower(label))
	}
	if !confirm {
		return first, nil
	}
	second, err := read("Confirm " + strings.ToLower(label) + ": ")
	if err != nil {
		return "", err
	}
	if first != second {
		return "", fmt.Errorf("%s entries do not match", strings.ToLower(label))
	}
	return first, nil
}
