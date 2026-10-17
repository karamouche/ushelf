package cli

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/karamouche/ushelf/apps/cli/internal/api"
	"github.com/spf13/cobra"
)

func (s *commandState) connectorsCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "connectors",
		Short: "List the AI apps connected to the current context over OAuth",
		Long: "List the remote MCP connectors, such as Claude and ChatGPT, that are authorized to use\n" +
			"the current context's library, and print the URL to add as a custom connector.\n\n" +
			"Connectors sign in with OAuth: you approve each one in the browser with the app password.\n" +
			"Local agents keep using `ushelf mcp`, which authenticates with the API token instead.",
		Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			current, err := s.currentContext()
			if err != nil {
				return err
			}
			client, err := current.Client()
			if err != nil {
				return err
			}
			connectors, err := client.Connectors(command.Context())
			if err != nil {
				return fmt.Errorf("list connectors: %w", err)
			}
			mcpURL := client.Endpoint("mcp")
			fmt.Fprintf(s.deps.Stdout, "Connector URL: %s\n", mcpURL)
			if parsed, err := url.Parse(mcpURL); err == nil && api.IsLoopbackHost(parsed.Hostname()) {
				fmt.Fprintln(s.deps.Stdout, "Note: Claude and ChatGPT connect from the internet, so they need a deployment with a public HTTPS URL.")
			}
			if len(connectors) == 0 {
				fmt.Fprintln(s.deps.Stdout, "\nNo connectors are authorized. Add the URL above as a custom connector in Claude or ChatGPT.")
				return nil
			}
			fmt.Fprintln(s.deps.Stdout)
			table := tabwriter.NewWriter(s.deps.Stdout, 0, 4, 2, ' ', 0)
			fmt.Fprintln(table, "NAME\tRETURNS TO\tCONNECTED\tLAST USED\tCLIENT ID")
			for _, connector := range connectors {
				name := connector.ClientName
				if name == "" {
					name = "(unnamed)"
				}
				fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\n", name, redirectHosts(connector.RedirectURIs),
					connector.ConnectedAt.Local().Format(time.DateOnly), connector.LastUsedAt.Local().Format(time.DateTime),
					connector.ClientID)
			}
			return table.Flush()
		},
	}
	command.AddCommand(s.connectorsRevokeCommand())
	return command
}

func (s *commandState) connectorsRevokeCommand() *cobra.Command {
	var all, yes bool
	command := &cobra.Command{
		Use:   "revoke [CLIENT_ID]",
		Short: "Revoke a connector, or every connector with --all",
		Long: "Revoke a connector's tokens and registration immediately. The AI app must be connected\n" +
			"again, with the app password, before it can use the library.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if all == (len(args) == 1) {
				return errors.New("pass a CLIENT_ID from `ushelf connectors`, or --all")
			}
			current, err := s.currentContext()
			if err != nil {
				return err
			}
			client, err := current.Client()
			if err != nil {
				return err
			}
			if !all {
				if err := client.RevokeConnector(command.Context(), args[0]); err != nil {
					var apiErr *api.Error
					if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
						return fmt.Errorf("no connector has client ID %s; run `ushelf connectors` to list them", args[0])
					}
					return fmt.Errorf("revoke connector: %w", err)
				}
				s.actions().Done("Revoked connector %s", args[0])
				return nil
			}
			if !yes {
				fmt.Fprint(s.deps.Stdout, "Disconnect every AI app connected to this library? [y/N] ")
				if !confirmed(bufio.NewReader(s.deps.Stdin)) {
					return errors.New("revoke cancelled")
				}
			}
			revoked, err := client.RevokeAllConnectors(command.Context())
			if err != nil {
				return fmt.Errorf("revoke connectors: %w", err)
			}
			s.actions().Done("Revoked %d connector%s", revoked, plural(revoked))
			return nil
		},
	}
	command.Flags().BoolVar(&all, "all", false, "revoke every connector")
	command.Flags().BoolVar(&yes, "yes", false, "confirm --all without prompting")
	return command
}

func redirectHosts(uris []string) string {
	seen := map[string]bool{}
	hosts := []string{}
	for _, uri := range uris {
		parsed, err := url.Parse(uri)
		if err != nil || seen[parsed.Hostname()] {
			continue
		}
		seen[parsed.Hostname()] = true
		hosts = append(hosts, parsed.Hostname())
	}
	return strings.Join(hosts, ",")
}

func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}
