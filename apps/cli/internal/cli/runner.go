package cli

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
)

type Runner interface {
	Run(context.Context, io.Reader, io.Writer, io.Writer, string, ...string) error
	Output(context.Context, string, ...string) (string, error)
}

type OSRunner struct{}

func (OSRunner) Run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin = stdin
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s: %w", commandString(name, args), err)
	}
	return nil
}

func (OSRunner) Output(ctx context.Context, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return stdout.String(), fmt.Errorf("%s: %w: %s", commandString(name, args), err, detail)
		}
		return stdout.String(), fmt.Errorf("%s: %w", commandString(name, args), err)
	}
	return stdout.String(), nil
}

func commandString(name string, args []string) string {
	return strings.Join(append([]string{name}, args...), " ")
}
