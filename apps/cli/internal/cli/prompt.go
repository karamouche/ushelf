package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

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
