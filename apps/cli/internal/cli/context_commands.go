package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

func (s *commandState) contextCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "context",
		Short: "List, switch, and register uShelf servers",
		Long: "A context names one uShelf server and how to reach it. `ushelf deploy` creates\n" +
			"contexts for servers it manages; `ushelf context add` registers a server deployed\n" +
			"another way, such as Docker Compose or Kubernetes, by URL and API token.",
	}
	command.AddCommand(s.contextListCommand(), s.contextUseCommand(), s.contextShowCommand(), s.contextAddCommand(), s.contextRemoveCommand())
	return command
}

func (s *commandState) contextListCommand() *cobra.Command {
	return &cobra.Command{Use: "list", Aliases: []string{"ls"}, Short: "List contexts", Args: cobra.NoArgs, RunE: func(*cobra.Command, []string) error {
		config, err := s.store.Load()
		if err != nil {
			return err
		}
		if len(config.Contexts) == 0 {
			fmt.Fprintln(s.deps.Stdout, "No contexts. Run `ushelf start` or `ushelf deploy`.")
			return nil
		}
		names := make([]string, 0, len(config.Contexts))
		for name := range config.Contexts {
			names = append(names, name)
		}
		sort.Strings(names)
		current := s.selectedContextName(config)
		table := tabwriter.NewWriter(s.deps.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(table, "CURRENT\tNAME\tDRIVER\tURL")
		for _, name := range names {
			marker := ""
			if name == current {
				marker = "*"
			}
			resolved := Context{Name: name, Spec: config.Contexts[name], Version: s.build.Version}
			fmt.Fprintf(table, "%s\t%s\t%s\t%s\n", marker, name, resolved.Spec.Driver, resolved.URL())
		}
		return table.Flush()
	}}
}

func (s *commandState) contextUseCommand() *cobra.Command {
	return &cobra.Command{Use: "use NAME", Short: "Make a context current", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		config, err := s.store.Load()
		if err != nil {
			return err
		}
		if _, ok := config.Contexts[args[0]]; !ok {
			return fmt.Errorf("context %q does not exist", args[0])
		}
		config.CurrentContext = args[0]
		if err := s.store.Save(config); err != nil {
			return err
		}
		s.actions().Done("Switched to context %s", args[0])
		return nil
	}}
}

func (s *commandState) contextShowCommand() *cobra.Command {
	return &cobra.Command{Use: "show [NAME]", Short: "Show a context without revealing its secrets", Args: cobra.MaximumNArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		current, err := s.namedOrCurrentContext(args)
		if err != nil {
			return err
		}
		value := map[string]any{"name": current.Name, "url": current.URL(), "spec": current.Spec,
			"apiToken": configuredLabel(current.Credentials.APIToken), "appPassword": configuredLabel(current.Credentials.AppPassword)}
		if current.Managed() {
			value["image"] = current.Image()
		}
		encoded, _ := json.MarshalIndent(value, "", "  ")
		fmt.Fprintln(s.deps.Stdout, string(encoded))
		return nil
	}}
}

func (s *commandState) contextAddCommand() *cobra.Command {
	var serverURL string
	command := &cobra.Command{
		Use:   "add NAME --url URL",
		Short: "Register a uShelf server deployed outside the CLI",
		Long: "Register a uShelf server deployed outside the CLI, such as with Docker Compose.\n\n" +
			"The server must run with USHELF_API_TOKEN set. The CLI reads the same token from\n" +
			"USHELF_API_TOKEN or prompts for it without echo, and verifies it before saving.",
		Example: "  ushelf context add homelab --url https://shelf.example.com",
		Args:    cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			name := args[0]
			if err := validateContextName(name); err != nil {
				return err
			}
			config, err := s.store.Load()
			if err != nil {
				return err
			}
			if _, ok := config.Contexts[name]; ok {
				return fmt.Errorf("context %q already exists; remove it first", name)
			}
			spec := ContextSpec{Driver: DriverExternal, URL: normalizeURL(serverURL)}
			if err := spec.Validate(); err != nil {
				return err
			}
			token := os.Getenv("USHELF_API_TOKEN")
			if token == "" {
				if token, err = promptSecret(s.deps.Stdin, s.deps.Stderr, "API token", false); err != nil {
					return err
				}
			}
			candidate := Context{Name: name, Spec: spec, Credentials: Credentials{APIToken: token}, Home: s.store.Home, Version: s.build.Version}
			client, err := candidate.Client()
			if err != nil {
				return err
			}
			s.actions().Step("Verifying %s...", candidate.URL())
			info, err := client.Server(command.Context())
			if err != nil {
				return fmt.Errorf("verify server: %w", err)
			}
			credentials, err := s.store.LoadCredentials()
			if err != nil {
				return err
			}
			credentials[name] = candidate.Credentials
			config.Contexts[name] = spec
			config.CurrentContext = name
			if err := s.store.SaveCredentials(credentials); err != nil {
				return err
			}
			if err := s.store.Save(config); err != nil {
				return err
			}
			s.actions().Done("Added context %s for uShelf %s at %s", name, info.Version, candidate.URL())
			return nil
		},
	}
	command.Flags().StringVar(&serverURL, "url", "", "server URL, including any base path")
	_ = command.MarkFlagRequired("url")
	return command
}

func (s *commandState) contextRemoveCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "remove NAME",
		Short: "Forget a context and its credentials",
		Long: "Forget a context and its credentials on this machine. The deployment itself and\n" +
			"its library are left untouched; run `ushelf --context NAME stop` first to stop it.",
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			config, err := s.store.Load()
			if err != nil {
				return err
			}
			if _, ok := config.Contexts[args[0]]; !ok {
				return fmt.Errorf("context %q does not exist", args[0])
			}
			credentials, err := s.store.LoadCredentials()
			if err != nil {
				return err
			}
			delete(config.Contexts, args[0])
			delete(credentials, args[0])
			if config.CurrentContext == args[0] {
				config.CurrentContext = ""
			}
			if err := s.store.Save(config); err != nil {
				return err
			}
			if err := s.store.SaveCredentials(credentials); err != nil {
				return err
			}
			s.actions().Done("Removed context %s; its deployment was not changed", args[0])
			return nil
		},
	}
}

func (s *commandState) namedOrCurrentContext(args []string) (Context, error) {
	if len(args) == 0 {
		return s.currentContext()
	}
	config, err := s.store.Load()
	if err != nil {
		return Context{}, err
	}
	return s.loadContext(config, args[0])
}

func configuredLabel(value string) string {
	if value == "" {
		return "unset"
	}
	return "configured"
}
