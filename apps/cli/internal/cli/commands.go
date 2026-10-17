package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
	"github.com/karamouche/ushelf/apps/cli/internal/mcpbridge"
	"github.com/spf13/cobra"
)

type BuildInfo struct {
	Version, Commit, BuildDate string
}

type Dependencies struct {
	Runner         Runner
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	Kindle         kindle.Provider
}

type commandState struct {
	deps        Dependencies
	build       BuildInfo
	homeFlag    string
	contextFlag string
	store       Store
}

func NewRootCommand(deps Dependencies, build BuildInfo) *cobra.Command {
	if deps.Kindle == nil {
		deps.Kindle = kindle.STKProvider{}
	}
	state := &commandState{deps: deps, build: build}
	root := &cobra.Command{
		Use:   "ushelf",
		Short: "Deploy uShelf anywhere and connect your agents to it",
		Long: "Deploy uShelf anywhere and connect your agents to it.\n\n" +
			"Each context names one uShelf server: a local Docker container, a Docker host\n" +
			"reached over SSH, a Fly.io app, or a server you deployed yourself. Commands act\n" +
			"on the current context unless --context selects another.",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       build.Version,
		PersistentPreRunE: func(*cobra.Command, []string) error {
			home, err := ResolveHome(state.homeFlag)
			if err != nil {
				return err
			}
			state.store = Store{Home: home}
			return nil
		},
	}
	root.SetIn(deps.Stdin)
	root.SetOut(deps.Stdout)
	root.SetErr(deps.Stderr)
	root.PersistentFlags().StringVar(&state.homeFlag, "home", "", "uShelf home directory (default ~/.ushelf)")
	root.PersistentFlags().StringVar(&state.contextFlag, "context", "", "context to use (default: the current context)")

	root.AddCommand(
		state.deployCommand(), state.startCommand(), state.stopCommand(), state.statusCommand(),
		state.logsCommand(), state.openCommand(), state.mcpCommand(), state.setupCommand(),
		state.doctorCommand(), state.versionCommand(), state.updateCommand(), state.rebuildCommand(),
		state.importCommand(), state.contextCommand(), state.configCommand(), state.kindleCommand(),
	)
	return root
}

func (s *commandState) actions() *actionReporter {
	return newActionReporter(s.deps.Stderr, s.deps.Stdout)
}

// selectedContextName applies --context, then USHELF_CONTEXT, then the saved current context.
func (s *commandState) selectedContextName(config fileConfig) string {
	if s.contextFlag != "" {
		return s.contextFlag
	}
	if value := os.Getenv("USHELF_CONTEXT"); value != "" {
		return value
	}
	return config.CurrentContext
}

func (s *commandState) currentContext() (Context, error) {
	config, err := s.store.Load()
	if err != nil {
		return Context{}, err
	}
	name := s.selectedContextName(config)
	if name == "" {
		return Context{}, errors.New("no uShelf context is configured; run `ushelf start` or `ushelf deploy`")
	}
	return s.loadContext(config, name)
}

func (s *commandState) loadContext(config fileConfig, name string) (Context, error) {
	spec, ok := config.Contexts[name]
	if !ok {
		return Context{}, fmt.Errorf("context %q does not exist; run `ushelf context list`", name)
	}
	credentials, err := s.store.LoadCredentials()
	if err != nil {
		return Context{}, err
	}
	return Context{Name: name, Spec: spec, Credentials: credentials[name], Home: s.store.Home, Version: s.build.Version}, nil
}

func (s *commandState) currentDeployment() (Context, Deployment, error) {
	current, err := s.currentContext()
	if err != nil {
		return Context{}, nil, err
	}
	deployment, err := s.deploymentFor(current)
	return current, deployment, err
}

func (s *commandState) startCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Deploy or reconcile the current context (a local server when none exists)",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			config, err := s.store.Load()
			if err != nil {
				return err
			}
			name := s.selectedContextName(config)
			if name == "" {
				return s.deploy(command.Context(), "local", ContextSpec{Driver: DriverLocal})
			}
			if _, ok := config.Contexts[name]; !ok && name == "local" {
				return s.deploy(command.Context(), "local", ContextSpec{Driver: DriverLocal})
			}
			current, err := s.loadContext(config, name)
			if err != nil {
				return err
			}
			return s.apply(command.Context(), current)
		},
	}
}

func (s *commandState) stopCommand() *cobra.Command {
	return &cobra.Command{Use: "stop", Short: "Stop the current context's server without deleting data", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		_, deployment, err := s.currentDeployment()
		if err != nil {
			return err
		}
		return deployment.Stop(command.Context())
	}}
}

func (s *commandState) statusCommand() *cobra.Command {
	return &cobra.Command{Use: "status", Short: "Show the current context's deployment and server health", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		current, err := s.currentContext()
		if err != nil {
			return err
		}
		out := s.deps.Stdout
		fmt.Fprintf(out, "Context: %s (%s)\nURL: %s\n", current.Name, current.Spec.Driver, current.URL())
		if current.Managed() {
			deployment, err := s.deploymentFor(current)
			if err != nil {
				return err
			}
			state, err := deployment.State(command.Context())
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "Deployment: %s\nImage: %s\n", state, current.Image())
		}
		health, version := "unreachable", "unavailable"
		if client, err := current.Client(); err == nil {
			if result, err := client.Health(command.Context()); err == nil && result.OK {
				health = "ok"
			}
			if info, err := client.Server(command.Context()); err == nil {
				version = info.Version
			} else if health == "ok" {
				version = "unavailable: " + err.Error()
			}
		}
		fmt.Fprintf(out, "Health: %s\nServer version: %s\nCLI version: %s\n", health, version, s.build.Version)
		if current.Spec.Driver == DriverLocal {
			fmt.Fprintf(out, "Home: %s\n", current.Home)
		}
		return nil
	}}
}

func (s *commandState) logsCommand() *cobra.Command {
	var follow bool
	var tail int
	command := &cobra.Command{Use: "logs", Short: "Show the current context's server logs", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		_, deployment, err := s.currentDeployment()
		if err != nil {
			return err
		}
		return deployment.Logs(command.Context(), follow, tail)
	}}
	command.Flags().BoolVarP(&follow, "follow", "f", false, "follow log output")
	command.Flags().IntVar(&tail, "tail", 200, "number of lines to show (Docker drivers)")
	return command
}

func (s *commandState) openCommand() *cobra.Command {
	return &cobra.Command{Use: "open", Short: "Open the current context's reader in a browser", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		current, err := s.currentContext()
		if err != nil {
			return err
		}
		actions := s.actions()
		actions.Step("Opening the uShelf reader...")
		if err := runQuiet(command.Context(), s.deps.Runner, browserOpener(), current.URL()); err != nil {
			return err
		}
		actions.Done("Opened %s", current.URL())
		return nil
	}}
}

func (s *commandState) mcpCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "mcp",
		Short: "Run a stdio MCP server that relays to the current context",
		Long: "Run a stdio MCP server for agent clients. Messages are relayed to the context's\n" +
			"server over HTTPS with its API token; stdout carries only MCP protocol traffic.",
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
			bridge := &mcpbridge.Bridge{Endpoint: client.Endpoint("mcp"), Token: client.Token(), Log: s.deps.Stderr}
			return bridge.Run(command.Context(), s.deps.Stdin, s.deps.Stdout)
		},
	}
}

func (s *commandState) rebuildCommand() *cobra.Command {
	return &cobra.Command{Use: "rebuild-index", Short: "Rebuild the disposable search index (Docker drivers)", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		maintainer, err := s.currentMaintainer()
		if err != nil {
			return err
		}
		return maintainer.RebuildIndex(command.Context())
	}}
}

func (s *commandState) importCommand() *cobra.Command {
	return &cobra.Command{Use: "import FILE", Short: "Import a compatible Markdown item (Docker drivers)", Args: cobra.ExactArgs(1), RunE: func(command *cobra.Command, args []string) error {
		maintainer, err := s.currentMaintainer()
		if err != nil {
			return err
		}
		return maintainer.Import(command.Context(), args[0])
	}}
}

func (s *commandState) currentMaintainer() (Maintainer, error) {
	current, deployment, err := s.currentDeployment()
	if err != nil {
		return nil, err
	}
	maintainer, ok := deployment.(Maintainer)
	if !ok {
		return nil, fmt.Errorf("context %q uses the %s driver, which does not support offline maintenance; the server rebuilds its index from Markdown on startup", current.Name, current.Spec.Driver)
	}
	return maintainer, nil
}

func (s *commandState) versionCommand() *cobra.Command {
	return &cobra.Command{Use: "version", Short: "Print version information", Args: cobra.NoArgs, Run: func(*cobra.Command, []string) {
		fmt.Fprintf(s.deps.Stdout, "uShelf %s\ncommit: %s\nbuilt: %s\n", s.build.Version, s.build.Commit, s.build.BuildDate)
		if current, err := s.currentContext(); err == nil && current.Managed() {
			fmt.Fprintf(s.deps.Stdout, "context: %s\nimage: %s\n", current.Name, current.Image())
		}
	}}
}

func (s *commandState) updateCommand() *cobra.Command {
	var check bool
	command := &cobra.Command{Use: "update", Short: "Update the CLI and roll the current context to the matching image", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.update(command.Context(), check)
	}}
	command.Flags().BoolVar(&check, "check", false, "check for an update without installing it")
	return command
}

func browserOpener() string {
	if runtime.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

func supportedPlatform() error {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return fmt.Errorf("unsupported operating system %s", runtime.GOOS)
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return fmt.Errorf("unsupported architecture %s", runtime.GOARCH)
	}
	return nil
}

func executablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}

func runQuiet(ctx context.Context, runner Runner, name string, args ...string) error {
	_, err := runner.Output(ctx, name, args...)
	return err
}
