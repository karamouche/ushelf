package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"
)

func (s *commandState) doctorCommand() *cobra.Command {
	return &cobra.Command{Use: "doctor", Short: "Check the CLI, the current deployment, and the server it serves", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		failures := 0
		check := func(name string, err error) {
			if err != nil {
				failures++
				fmt.Fprintf(s.deps.Stdout, "FAIL %-18s %v\n", name, err)
			} else {
				fmt.Fprintf(s.deps.Stdout, "PASS %s\n", name)
			}
		}
		check("platform", supportedPlatform())
		current, err := s.currentContext()
		check("context", err)
		if err != nil {
			return fmt.Errorf("doctor found %d problem(s)", failures)
		}
		fmt.Fprintf(s.deps.Stdout, "INFO context %s (%s) at %s\n", current.Name, current.Spec.Driver, current.URL())
		if current.Managed() {
			deployment, err := s.deploymentFor(current)
			if err != nil {
				return err
			}
			deployment.Diagnose(command.Context(), check)
		}
		if client, err := current.Client(); err != nil {
			check("server", err)
		} else {
			health, err := client.Health(command.Context())
			if err == nil && !health.OK {
				err = fmt.Errorf("health check did not report ok")
			}
			check("server health", err)
			info, err := client.Server(command.Context())
			check("api token", err)
			if err == nil {
				fmt.Fprintf(s.deps.Stdout, "INFO server version %s\n", info.Version)
				s.reportKindleDoctor(command.Context(), client)
			}
		}
		s.reportClients(command.Context())
		if failures > 0 {
			return fmt.Errorf("doctor found %d problem(s)", failures)
		}
		fmt.Fprintf(s.deps.Stdout, "uShelf context %s is ready\n", current.Name)
		return nil
	}}
}

func (s *commandState) reportClients(ctx context.Context) {
	for _, client := range []string{"codex", "claude"} {
		if _, err := s.deps.Runner.Output(ctx, client, "mcp", "get", "ushelf"); err == nil {
			fmt.Fprintf(s.deps.Stdout, "INFO %s MCP configured\n", client)
		} else {
			fmt.Fprintf(s.deps.Stdout, "INFO %s MCP not configured\n", client)
		}
	}
}
