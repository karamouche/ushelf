package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

type deployFlags struct {
	name, image, basePath, host, domain, url, app, region, org string
	port                                                       int
}

func (s *commandState) deployCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "deploy",
		Short: "Deploy uShelf locally, to a Docker host over SSH, or to Fly.io",
		Long: "Deploy uShelf and save the result as a context.\n\n" +
			"Deploying generates an API token for the CLI and agents. Remote deployments also\n" +
			"require a reader password, read from USHELF_APP_PASSWORD or prompted without echo.\n" +
			"Redeploying an existing context keeps its saved settings unless flags override them.",
		Example: `  ushelf deploy local
  ushelf deploy ssh me@vps.example.com --domain shelf.example.com
  ushelf deploy ssh me@nas.local --url https://nas.tailnet.ts.net --host 127.0.0.1
  ushelf deploy fly --app my-shelf --region cdg`,
	}
	command.AddCommand(s.deployLocalCommand(), s.deploySSHCommand(), s.deployFlyCommand())
	return command
}

func addCommonDeployFlags(command *cobra.Command, flags *deployFlags, defaultName string) {
	command.Flags().StringVar(&flags.name, "name", defaultName, "context name to create or update")
	command.Flags().StringVar(&flags.image, "image", "", "runtime image (default: the image matching this CLI)")
	command.Flags().StringVar(&flags.basePath, "base-path", "", "URL path prefix for the reader, API, and MCP endpoint")
}

func (s *commandState) deployLocalCommand() *cobra.Command {
	flags := &deployFlags{}
	command := &cobra.Command{
		Use:   "local",
		Short: "Run uShelf in the local Docker daemon with data in the uShelf home",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return s.deploy(command.Context(), flags.name, ContextSpec{
				Driver: DriverLocal, Image: flags.image, BasePath: flags.basePath, Host: flags.host, Port: flags.port,
			})
		},
	}
	addCommonDeployFlags(command, flags, "local")
	command.Flags().StringVar(&flags.host, "host", "", "address to publish on (default 127.0.0.1)")
	command.Flags().IntVar(&flags.port, "port", 0, "HTTP port (default 43110)")
	return command
}

func (s *commandState) deploySSHCommand() *cobra.Command {
	flags := &deployFlags{}
	command := &cobra.Command{
		Use:   "ssh USER@HOST[:PORT]",
		Short: "Run uShelf on any Docker host reachable over SSH",
		Long: "Run uShelf with the Docker daemon of a remote host reached over SSH. Library data\n" +
			"lives in the ushelf-data Docker volume on that host.\n\n" +
			"With --domain, a Caddy container serves uShelf over HTTPS with an automatic\n" +
			"Let's Encrypt certificate; point the domain's DNS at the host and open ports 80\n" +
			"and 443. With --url, uShelf is published on --host:--port of the remote host and\n" +
			"you provide HTTPS yourself, for example with a reverse proxy or Tailscale Serve.",
		Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			name := flags.name
			if name == "" {
				name = contextNameFromHost(args[0])
			}
			return s.deploy(command.Context(), name, ContextSpec{
				Driver: DriverSSH, SSH: args[0], Image: flags.image, BasePath: flags.basePath,
				Host: flags.host, Port: flags.port, Domain: flags.domain, URL: normalizeOptionalURL(flags.url),
			})
		},
	}
	addCommonDeployFlags(command, flags, "")
	command.Flags().StringVar(&flags.domain, "domain", "", "serve over HTTPS at this domain with a managed Caddy proxy")
	command.Flags().StringVar(&flags.url, "url", "", "public HTTPS URL when you run your own proxy")
	command.Flags().StringVar(&flags.host, "host", "", "remote address to publish on with --url (default 127.0.0.1)")
	command.Flags().IntVar(&flags.port, "port", 0, "HTTP port (default 43110)")
	command.MarkFlagsMutuallyExclusive("domain", "url")
	return command
}

func (s *commandState) deployFlyCommand() *cobra.Command {
	flags := &deployFlags{}
	command := &cobra.Command{
		Use:   "fly",
		Short: "Run uShelf as a Fly.io app with a persistent volume",
		Long: "Run uShelf as a single Fly.io Machine with a 1 GB volume, served over HTTPS at\n" +
			"https://APP.fly.dev. Requires flyctl and `fly auth login`. Machines stop when idle\n" +
			"and start on the next request.",
		Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			name := flags.name
			if name == "" {
				name = flags.app
			}
			if name == "" {
				return fmt.Errorf("--app is required for a new Fly.io deployment")
			}
			return s.deploy(command.Context(), name, ContextSpec{
				Driver: DriverFly, App: flags.app, Region: flags.region, Org: flags.org, Image: flags.image, BasePath: flags.basePath,
			})
		},
	}
	addCommonDeployFlags(command, flags, "")
	command.Flags().StringVar(&flags.app, "app", "", "globally unique Fly.io app name")
	command.Flags().StringVar(&flags.region, "region", "", "Fly.io region code, such as cdg or iad")
	command.Flags().StringVar(&flags.org, "org", "", "Fly.io organization for a new app (default: personal)")
	return command
}

// deploy saves the merged context and its credentials, makes it current, and applies it.
func (s *commandState) deploy(ctx context.Context, name string, override ContextSpec) error {
	if err := validateContextName(name); err != nil {
		return err
	}
	config, err := s.store.Load()
	if err != nil {
		return err
	}
	spec, exists := config.Contexts[name]
	if exists && spec.Driver != override.Driver {
		return fmt.Errorf("context %q already uses the %s driver; choose another --name", name, spec.Driver)
	}
	spec = mergeSpec(spec, override)
	if err := spec.Validate(); err != nil {
		return err
	}
	allCredentials, err := s.store.LoadCredentials()
	if err != nil {
		return err
	}
	credentials := allCredentials[name]
	if credentials.APIToken == "" {
		if credentials.APIToken, err = newAPIToken(); err != nil {
			return err
		}
	}
	if spec.Driver != DriverLocal && credentials.AppPassword == "" {
		if credentials.AppPassword, err = s.requireAppPassword(); err != nil {
			return err
		}
	}
	config.Contexts[name] = spec
	config.CurrentContext = name
	allCredentials[name] = credentials
	if err := s.store.SaveCredentials(allCredentials); err != nil {
		return err
	}
	if err := s.store.Save(config); err != nil {
		return err
	}
	return s.apply(ctx, Context{Name: name, Spec: spec, Credentials: credentials, Home: s.store.Home, Version: s.build.Version})
}

func (s *commandState) requireAppPassword() (string, error) {
	if value := os.Getenv("USHELF_APP_PASSWORD"); value != "" {
		return value, nil
	}
	fmt.Fprintln(s.deps.Stderr, "A remote uShelf is reachable from the network, so its reader needs a password.")
	return promptSecret(s.deps.Stdin, s.deps.Stderr, "App password", true)
}

// apply deploys a context and waits until its API accepts the context's token.
func (s *commandState) apply(ctx context.Context, current Context) error {
	deployment, err := s.deploymentFor(current)
	if err != nil {
		return err
	}
	if err := deployment.Apply(ctx); err != nil {
		return err
	}
	client, err := current.Client()
	if err != nil {
		return err
	}
	actions := s.actions()
	actions.Step("Waiting for %s to accept requests...", current.URL())
	info, err := waitForServer(ctx, client)
	if err != nil {
		return err
	}
	actions.Done("uShelf %s is ready at %s (context %s)", info.Version, current.URL(), current.Name)
	return nil
}

// mergeSpec applies the explicitly provided fields of override to an existing spec.
func mergeSpec(existing, override ContextSpec) ContextSpec {
	merged := existing
	merged.Driver = override.Driver
	set := func(target *string, value string) {
		if value != "" {
			*target = value
		}
	}
	set(&merged.Image, override.Image)
	set(&merged.BasePath, override.BasePath)
	set(&merged.Host, override.Host)
	set(&merged.SSH, override.SSH)
	set(&merged.App, override.App)
	set(&merged.Region, override.Region)
	set(&merged.Org, override.Org)
	if override.Port != 0 {
		merged.Port = override.Port
	}
	if merged.BasePath != "" {
		merged.BasePath = normalizeBasePath(merged.BasePath)
	}
	// An ssh context is exposed either through a managed domain or a user-provided URL.
	if override.Domain != "" {
		merged.Domain, merged.URL = override.Domain, ""
	}
	if override.URL != "" {
		merged.URL, merged.Domain = override.URL, ""
	}
	return merged
}

func contextNameFromHost(target string) string {
	host := target
	for index := len(host) - 1; index >= 0; index-- {
		if host[index] == '@' {
			host = host[index+1:]
			break
		}
	}
	for index := 0; index < len(host); index++ {
		if host[index] == ':' || host[index] == '.' {
			host = host[:index]
			break
		}
	}
	if validateContextName(host) != nil {
		return "remote"
	}
	return host
}

func normalizeOptionalURL(value string) string {
	if value == "" {
		return ""
	}
	return normalizeURL(value)
}
