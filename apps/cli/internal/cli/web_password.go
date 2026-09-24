package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/term"
)

const webPasswordFilename = "web-password"

func webPasswordPath(home string) string {
	return filepath.Join(home, "secrets", webPasswordFilename)
}

func readWebPassword(home string) (string, error) {
	value, err := os.ReadFile(webPasswordPath(home))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read web password: %w", err)
	}
	if len(value) == 0 {
		return "", fmt.Errorf("web password file is empty; run ushelf config set web-password or ushelf config unset web-password")
	}
	return string(value), nil
}

func writeWebPassword(home, value string) error {
	if value == "" {
		return fmt.Errorf("web password cannot be empty")
	}
	secretPath := webPasswordPath(home)
	if err := os.MkdirAll(filepath.Dir(secretPath), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(secretPath), ".web-password-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.WriteString(value); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), secretPath)
}

func unsetWebPassword(home string) error {
	err := os.Remove(webPasswordPath(home))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func promptWebPassword(input io.Reader, output io.Writer) (string, error) {
	if file, ok := input.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		read := func(prompt string) (string, error) {
			if _, err := fmt.Fprint(output, prompt); err != nil {
				return "", err
			}
			value, err := term.ReadPassword(int(file.Fd()))
			fmt.Fprintln(output)
			return string(value), err
		}
		first, err := read("Web password: ")
		if err != nil {
			return "", err
		}
		second, err := read("Confirm web password: ")
		if err != nil {
			return "", err
		}
		if first == "" {
			return "", fmt.Errorf("web password cannot be empty")
		}
		if first != second {
			return "", fmt.Errorf("passwords do not match")
		}
		return first, nil
	}
	reader := bufio.NewReader(input)
	read := func() (string, error) {
		value, err := reader.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		if value == "" {
			return "", io.ErrUnexpectedEOF
		}
		return strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r"), nil
	}
	first, err := read()
	if err != nil {
		return "", err
	}
	second, err := read()
	if err != nil {
		return "", err
	}
	if first == "" {
		return "", fmt.Errorf("web password cannot be empty")
	}
	if first != second {
		return "", fmt.Errorf("passwords do not match")
	}
	return first, nil
}
