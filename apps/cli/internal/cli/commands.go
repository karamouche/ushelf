package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
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
	deps     Dependencies
	build    BuildInfo
	flags    FlagValues
	settings Settings
}

func NewRootCommand(deps Dependencies, build BuildInfo) *cobra.Command {
	if deps.Kindle == nil {
		deps.Kindle = kindle.STKProvider{}
	}
	state := &commandState{deps: deps, build: build}
	root := &cobra.Command{
		Use:           "ushelf",
		Short:         "Run and manage your local uShelf library",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       build.Version,
		PersistentPreRunE: func(command *cobra.Command, _ []string) error {
			state.flags.Changed = command.Flags().Changed
			settings, err := ResolveSettings(state.flags, build.Version)
			if err != nil {
				return err
			}
			state.settings = settings
			return nil
		},
	}
	root.SetIn(deps.Stdin)
	root.SetOut(deps.Stdout)
	root.SetErr(deps.Stderr)
	root.PersistentFlags().StringVar(&state.flags.Home, "home", "", "uShelf home directory (default ~/.ushelf)")
	root.PersistentFlags().StringVar(&state.flags.Host, "host", "", "host address published by Docker")
	root.PersistentFlags().StringVar(&state.flags.Port, "port", "", "HTTP port")
	root.PersistentFlags().StringVar(&state.flags.BasePath, "base-path", "", "reader URL base path")
	root.PersistentFlags().StringVar(&state.flags.Image, "image", "", "runtime Docker image")

	root.AddCommand(
		state.startCommand(), state.stopCommand(), state.statusCommand(), state.logsCommand(),
		state.openCommand(), state.mcpCommand(), state.setupCommand(), state.doctorCommand(),
		state.versionCommand(), state.updateCommand(), state.rebuildCommand(), state.importCommand(),
		state.configCommand(), state.kindleCommand(),
	)
	return root
}

func (s *commandState) docker() Docker {
	return Docker{Settings: s.settings, Runner: s.deps.Runner, Stdin: s.deps.Stdin, Stdout: s.deps.Stdout, Stderr: s.deps.Stderr}
}

func (s *commandState) startCommand() *cobra.Command {
	return &cobra.Command{Use: "start", Short: "Start the uShelf reader and API", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.docker().Start(command.Context())
	}}
}

func (s *commandState) stopCommand() *cobra.Command {
	return &cobra.Command{Use: "stop", Short: "Stop uShelf without deleting data", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.docker().Stop(command.Context())
	}}
}

func (s *commandState) statusCommand() *cobra.Command {
	return &cobra.Command{Use: "status", Short: "Show service status", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.docker().Status(command.Context())
	}}
}

func (s *commandState) logsCommand() *cobra.Command {
	var follow bool
	var tail int
	command := &cobra.Command{Use: "logs", Short: "Show service logs", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.docker().Logs(command.Context(), follow, tail)
	}}
	command.Flags().BoolVarP(&follow, "follow", "f", false, "follow log output")
	command.Flags().IntVar(&tail, "tail", 200, "number of lines to show")
	return command
}

func (s *commandState) openCommand() *cobra.Command {
	return &cobra.Command{Use: "open", Short: "Open the reader in a browser", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		name := "xdg-open"
		if runtime.GOOS == "darwin" {
			name = "open"
		}
		return s.deps.Runner.Run(command.Context(), nil, s.deps.Stdout, s.deps.Stderr, name, s.settings.URL())
	}}
}

func (s *commandState) mcpCommand() *cobra.Command {
	return &cobra.Command{Use: "mcp", Short: "Run the stdio MCP server", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.docker().MCP(command.Context())
	}}
}

func (s *commandState) rebuildCommand() *cobra.Command {
	return &cobra.Command{Use: "rebuild-index", Short: "Rebuild the disposable search index", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.docker().Maintenance(command.Context(), "rebuild-index")
	}}
}

func (s *commandState) importCommand() *cobra.Command {
	return &cobra.Command{Use: "import FILE", Short: "Import a compatible Markdown item", Args: cobra.ExactArgs(1), RunE: func(command *cobra.Command, args []string) error {
		return s.docker().Import(command.Context(), args[0])
	}}
}

func (s *commandState) versionCommand() *cobra.Command {
	return &cobra.Command{Use: "version", Short: "Print version information", Args: cobra.NoArgs, Run: func(_ *cobra.Command, _ []string) {
		fmt.Fprintf(s.deps.Stdout, "uShelf %s\ncommit: %s\nbuilt: %s\nimage: %s\n", s.build.Version, s.build.Commit, s.build.BuildDate, s.settings.Image)
	}}
}

func (s *commandState) doctorCommand() *cobra.Command {
	return &cobra.Command{Use: "doctor", Short: "Check the local uShelf installation", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		docker := s.docker()
		failures := 0
		check := func(name string, err error) {
			if err != nil {
				failures++
				fmt.Fprintf(s.deps.Stdout, "FAIL %-16s %v\n", name, err)
			} else {
				fmt.Fprintf(s.deps.Stdout, "PASS %s\n", name)
			}
		}
		check("platform", supportedPlatform())
		_, err := s.deps.Runner.Output(command.Context(), "docker", "version", "--format", "{{.Server.Version}}")
		check("docker daemon", err)
		check("directories", docker.EnsureDirectories())
		check("permissions", docker.CheckWritable())
		check("port", docker.CheckPort())
		check("runtime image", docker.EnsureImage(command.Context()))
		check("image architecture", docker.CheckImageArchitecture(command.Context()))
		check("default recipe", docker.SeedRecipe(command.Context()))
		check("container health", docker.CheckManagedHealth(command.Context()))
		for _, client := range []string{"codex", "claude"} {
			if _, clientErr := s.deps.Runner.Output(command.Context(), client, "mcp", "get", "ushelf"); clientErr == nil {
				fmt.Fprintf(s.deps.Stdout, "INFO %s MCP configured\n", client)
			} else {
				fmt.Fprintf(s.deps.Stdout, "INFO %s MCP not configured\n", client)
			}
		}
		s.reportKindleDoctor(command.Context())
		if failures > 0 {
			return fmt.Errorf("doctor found %d problem(s)", failures)
		}
		fmt.Fprintf(s.deps.Stdout, "uShelf is ready to run from %s\n", s.settings.Home)
		return nil
	}}
}

func (s *commandState) kindleCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "kindle",
		Short: "Connect and manage Amazon Send to Kindle",
		Long: "Connect and manage the unofficial Amazon Send to Kindle integration.\n\n" +
			"Authentication is handled by Amazon in your browser; uShelf stores only a device credential.",
	}
	command.AddCommand(s.kindleSetupCommand(), s.kindleStatusCommand(), s.kindleDisconnectCommand())
	return command
}

func (s *commandState) kindleSetupCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Connect uShelf to an Amazon Kindle account",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			credentialPath := kindle.CredentialPath(s.settings.Home)
			if _, err := os.Stat(credentialPath); err == nil {
				return errors.New("Kindle is already configured; run `ushelf kindle disconnect` first")
			} else if !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("inspect Kindle credential: %w", err)
			}

			reader := bufio.NewReader(s.deps.Stdin)
			fmt.Fprintln(s.deps.Stdout, "WARNING: This integration is unofficial and uses Amazon's undocumented Send to Kindle protocol.")
			fmt.Fprintln(s.deps.Stdout, "Amazon may change or disable it without notice. Use it only with an account you own.")
			fmt.Fprint(s.deps.Stdout, "Continue? [y/N] ")
			answer, err := reader.ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			if normalized := strings.ToLower(strings.TrimSpace(answer)); normalized != "y" && normalized != "yes" {
				return errors.New("Kindle setup cancelled")
			}

			verifier, err := s.deps.Kindle.NewVerifier()
			if err != nil {
				return fmt.Errorf("create Amazon verifier: %w", err)
			}
			signInURL := s.deps.Kindle.SignInURL(verifier)
			fmt.Fprintf(s.deps.Stdout, "\nOpen this Amazon sign-in URL:\n\n%s\n\n", signInURL)
			opener := "xdg-open"
			if runtime.GOOS == "darwin" {
				opener = "open"
			}
			_ = s.deps.Runner.Run(command.Context(), nil, io.Discard, io.Discard, opener, signInURL)
			fmt.Fprint(s.deps.Stdout, "After Amazon finishes redirecting, paste the full URL from the address bar:\n> ")
			redirect, err := reader.ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			redirect = strings.TrimSpace(redirect)
			if err := validateKindleRedirect(redirect); err != nil {
				return err
			}
			code, err := s.deps.Kindle.AuthorizationCode(redirect)
			if err != nil {
				return errors.New("Amazon sign-in did not provide an authorization code")
			}
			ctx, cancel := context.WithTimeout(command.Context(), kindle.OperationTimeout)
			defer cancel()
			client, err := s.deps.Kindle.Register(ctx, code, verifier)
			if err != nil {
				return fmt.Errorf("register Kindle connection: %w", err)
			}
			if err := kindle.SaveCredential(credentialPath, client); err != nil {
				return err
			}
			fmt.Fprintf(s.deps.Stdout, "Kindle connected for %q (%s).\n", client.AccountName(), client.HomeRegion())
			return nil
		},
	}
}

func (s *commandState) kindleStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Check the Kindle connection and list devices",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := kindle.LoadCredential(s.deps.Kindle, kindle.CredentialPath(s.settings.Home))
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("Kindle is not configured; run `ushelf kindle setup`")
			}
			if err != nil {
				return fmt.Errorf("load Kindle credential: %w", err)
			}
			ctx, cancel := context.WithTimeout(command.Context(), kindle.OperationTimeout)
			defer cancel()
			devices, err := client.Devices(ctx)
			if err != nil {
				return fmt.Errorf("contact Amazon Send to Kindle: %w", err)
			}
			fmt.Fprintf(s.deps.Stdout, "Account: %s\nRegion: %s\nDevices: %d\n", client.AccountName(), client.HomeRegion(), len(devices))
			for _, device := range devices {
				fmt.Fprintf(s.deps.Stdout, "  %s · %s\n", device.Name, maskedSerial(device.Serial))
			}
			return nil
		},
	}
}

func (s *commandState) kindleDisconnectCommand() *cobra.Command {
	var yes, localOnly bool
	command := &cobra.Command{
		Use:   "disconnect",
		Short: "Deregister uShelf and remove the Kindle credential",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			credentialPath := kindle.CredentialPath(s.settings.Home)
			client, err := kindle.LoadCredential(s.deps.Kindle, credentialPath)
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("Kindle is not configured")
			}
			if err != nil && !localOnly {
				return fmt.Errorf("load Kindle credential: %w; use --local-only --yes only if it cannot be recovered", err)
			}
			if localOnly && !yes {
				return errors.New("--local-only requires --yes because the Amazon registration will remain active")
			}
			if !yes {
				fmt.Fprint(s.deps.Stdout, "Deregister uShelf from this Amazon account? [y/N] ")
				answer, readErr := bufio.NewReader(s.deps.Stdin).ReadString('\n')
				if readErr != nil && !errors.Is(readErr, io.EOF) {
					return readErr
				}
				if normalized := strings.ToLower(strings.TrimSpace(answer)); normalized != "y" && normalized != "yes" {
					return errors.New("Kindle disconnect cancelled")
				}
			}
			if !localOnly {
				ctx, cancel := context.WithTimeout(command.Context(), kindle.OperationTimeout)
				defer cancel()
				if err := client.Deregister(ctx); err != nil {
					return fmt.Errorf("deregister Kindle connection: %w", err)
				}
			}
			if err := os.Remove(credentialPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove Kindle credential: %w", err)
			}
			fmt.Fprintln(s.deps.Stdout, "Kindle disconnected.")
			return nil
		},
	}
	command.Flags().BoolVar(&yes, "yes", false, "confirm without prompting")
	command.Flags().BoolVar(&localOnly, "local-only", false, "remove only the local credential")
	return command
}

func (s *commandState) reportKindleDoctor(ctx context.Context) {
	credentialPath := kindle.CredentialPath(s.settings.Home)
	info, err := os.Stat(credentialPath)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(s.deps.Stdout, "INFO Kindle not configured")
		return
	}
	if err != nil {
		fmt.Fprintf(s.deps.Stdout, "INFO Kindle credential unavailable: %v\n", err)
		return
	}
	if info.Mode().Perm() != 0o600 {
		fmt.Fprintf(s.deps.Stdout, "INFO Kindle credential permissions are %04o; expected 0600\n", info.Mode().Perm())
		return
	}
	client, err := kindle.LoadCredential(s.deps.Kindle, credentialPath)
	if err != nil {
		fmt.Fprintln(s.deps.Stdout, "INFO Kindle credential is invalid; run `ushelf kindle setup`")
		return
	}
	ctx, cancel := context.WithTimeout(ctx, kindle.OperationTimeout)
	defer cancel()
	devices, err := client.Devices(ctx)
	if err != nil {
		fmt.Fprintf(s.deps.Stdout, "INFO Kindle configured, but Amazon connection is unavailable: %v\n", err)
		return
	}
	fmt.Fprintf(s.deps.Stdout, "INFO Kindle connected (%d device(s))\n", len(devices))
}

func validateKindleRedirect(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "www.amazon.com" || parsed.Path != "/gp/sendtokindle" {
		return errors.New("paste the final https://www.amazon.com/gp/sendtokindle URL")
	}
	return nil
}

func maskedSerial(value string) string {
	if len(value) <= 4 {
		return value
	}
	return "••••" + value[len(value)-4:]
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

func (s *commandState) configCommand() *cobra.Command {
	const keys = `Configurable keys:
  host       Address published by Docker
  port       HTTP port
  base-path  Web app and API URL prefix
  image      Runtime Docker image`

	command := &cobra.Command{
		Use:   "config",
		Short: "Manage persistent CLI configuration",
		Long:  "Manage persistent CLI configuration.\n\n" + keys,
		Example: `  ushelf config show
  ushelf config set base-path /reader/
  ushelf config unset base-path`,
	}
	show := &cobra.Command{
		Use:   "show",
		Short: "Show effective configuration",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			value := map[string]any{"home": s.settings.Home, "host": s.settings.Host, "port": s.settings.Port, "base-path": s.settings.BasePath, "image": s.settings.Image}
			encoded, _ := json.MarshalIndent(value, "", "  ")
			fmt.Fprintln(s.deps.Stdout, string(encoded))
			return nil
		},
	}
	path := &cobra.Command{
		Use:   "path",
		Short: "Print the configuration file path",
		Args:  cobra.NoArgs,
		Run:   func(_ *cobra.Command, _ []string) { fmt.Fprintln(s.deps.Stdout, s.settings.ConfigPath) },
	}
	set := &cobra.Command{
		Use:   "set KEY VALUE",
		Short: "Set a persistent configuration value",
		Long:  "Set a persistent configuration value.\n\n" + keys,
		Args: func(command *cobra.Command, args []string) error {
			if len(args) == 0 {
				return nil
			}
			return cobra.ExactArgs(2)(command, args)
		},
		ValidArgs: []string{"host", "port", "base-path", "image"},
		Example: `  ushelf config set host 0.0.0.0
  ushelf config set port 43120
  ushelf config set base-path /reader/
  ushelf config set image ghcr.io/karamouche/ushelf:latest`,
		RunE: func(command *cobra.Command, args []string) error {
			if len(args) == 0 {
				return command.Help()
			}
			return setConfigValue(s.settings.ConfigPath, args[0], args[1], false)
		},
	}
	unset := &cobra.Command{
		Use:       "unset KEY",
		Short:     "Restore a configuration value to its default",
		Long:      "Restore a configuration value to its default.\n\n" + keys,
		Args:      cobra.ExactArgs(1),
		ValidArgs: []string{"host", "port", "base-path", "image"},
		Example:   "  ushelf config unset base-path",
		RunE: func(_ *cobra.Command, args []string) error {
			return setConfigValue(s.settings.ConfigPath, args[0], "", true)
		},
	}
	command.AddCommand(show, path, set, unset)
	return command
}

func setConfigValue(path, key, value string, unset bool) error {
	config, err := readFileConfig(path)
	if err != nil {
		return err
	}
	switch strings.ToLower(key) {
	case "host":
		if unset {
			config.Host = ""
		} else {
			config.Host = value
		}
	case "port":
		if unset {
			config.Port = 0
		} else {
			port, parseErr := strconv.Atoi(value)
			if parseErr != nil {
				return fmt.Errorf("invalid port: %w", parseErr)
			}
			config.Port = port
		}
	case "base-path", "basepath":
		if unset {
			config.BasePath = ""
		} else {
			config.BasePath = normalizeBasePath(value)
		}
	case "image":
		if unset {
			config.Image = ""
		} else {
			config.Image = value
		}
	default:
		return fmt.Errorf("unknown config key %q; use host, port, base-path, or image", key)
	}
	probe := Settings{Home: filepath.Dir(path), Host: firstNonEmpty(config.Host, defaultHost), Port: firstNonZero(config.Port, defaultPort), BasePath: firstNonEmpty(config.BasePath, defaultBasePath), Image: firstNonEmpty(config.Image, "ghcr.io/karamouche/ushelf:latest")}
	probe.BasePath = normalizeBasePath(probe.BasePath)
	if err := probe.Validate(); err != nil {
		return err
	}
	return writeFileConfig(path, config)
}

func (s *commandState) setupCommand() *cobra.Command {
	var printOnly, force bool
	command := &cobra.Command{Use: "setup codex|claude|all", Short: "Configure an agent client and install uShelf skills", Args: cobra.ExactArgs(1), RunE: func(command *cobra.Command, args []string) error {
		client := strings.ToLower(args[0])
		if client != "codex" && client != "claude" && client != "all" {
			return fmt.Errorf("client must be codex, claude, or all")
		}
		return s.setupClients(command.Context(), client, printOnly, force)
	}}
	command.Flags().BoolVar(&printOnly, "print", false, "print setup commands without making changes")
	command.Flags().BoolVar(&force, "force", false, "replace conflicting uShelf entries and skill links")
	return command
}

func (s *commandState) updateCommand() *cobra.Command {
	var check bool
	command := &cobra.Command{Use: "update", Short: "Update the CLI and matching runtime image", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		return s.update(command.Context(), check)
	}}
	command.Flags().BoolVar(&check, "check", false, "check for an update without installing it")
	return command
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
