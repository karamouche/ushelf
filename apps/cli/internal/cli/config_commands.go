package cli

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

const configKeys = `Configurable keys for the current context:
  image         Runtime image (managed drivers)
  base-path     Reader, API, and MCP URL prefix (managed drivers)
  host          Address to publish on (local, ssh with --url)
  port          HTTP port (local, ssh)
  domain        HTTPS domain served by the managed proxy (ssh)
  url           Server URL (ssh with your own proxy, external)
  region        Fly.io region (fly)
  app-password  HTTP reader password (prompted and stored privately)`

var configKeyNames = []string{"image", "base-path", "host", "port", "domain", "url", "region", "app-password"}

func (s *commandState) configCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "config",
		Short: "Inspect or change the current context's settings",
		Long:  "Inspect or change the current context's settings. Run `ushelf start` to apply changes.\n\n" + configKeys,
		Example: `  ushelf config show
  ushelf config set base-path /reader/
  ushelf config set app-password
  ushelf config unset base-path`,
	}
	show := &cobra.Command{Use: "show", Short: "Show the current context's effective settings", Args: cobra.NoArgs, RunE: func(*cobra.Command, []string) error {
		current, err := s.currentContext()
		if err != nil {
			return err
		}
		value := map[string]any{"context": current.Name, "driver": current.Spec.Driver, "url": current.URL(),
			"app-password": configuredLabel(current.Credentials.AppPassword), "api-token": configuredLabel(current.Credentials.APIToken)}
		if current.Managed() {
			value["image"], value["base-path"] = current.Image(), current.BasePath()
		}
		switch current.Spec.Driver {
		case DriverLocal:
			value["home"], value["host"], value["port"] = current.Home, current.Host(), current.Port()
		case DriverSSH:
			value["ssh"], value["port"] = current.Spec.SSH, current.Port()
			if current.Spec.Domain != "" {
				value["domain"] = current.Spec.Domain
			} else {
				value["host"] = current.Host()
			}
		case DriverFly:
			value["app"], value["region"] = current.Spec.App, current.Spec.Region
		}
		encoded, _ := json.MarshalIndent(value, "", "  ")
		fmt.Fprintln(s.deps.Stdout, string(encoded))
		return nil
	}}
	path := &cobra.Command{Use: "path", Short: "Print the configuration file path", Args: cobra.NoArgs, Run: func(*cobra.Command, []string) {
		fmt.Fprintln(s.deps.Stdout, s.store.ConfigPath())
	}}
	set := &cobra.Command{
		Use:       "set KEY [VALUE]",
		Short:     "Set a setting on the current context",
		Long:      "Set a setting on the current context.\n\n" + configKeys,
		ValidArgs: configKeyNames,
		Args: func(command *cobra.Command, args []string) error {
			if len(args) == 0 {
				return nil
			}
			if args[0] == "app-password" {
				if len(args) != 1 {
					return fmt.Errorf("app-password is prompted; do not pass it as an argument")
				}
				return nil
			}
			return cobra.ExactArgs(2)(command, args)
		},
		RunE: func(command *cobra.Command, args []string) error {
			if len(args) == 0 {
				return command.Help()
			}
			return s.changeSetting(args[0], args[1:], false)
		},
	}
	unset := &cobra.Command{
		Use:       "unset KEY",
		Short:     "Restore a setting on the current context to its default",
		Long:      "Restore a setting on the current context to its default.\n\n" + configKeys,
		ValidArgs: configKeyNames,
		Args:      cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			return s.changeSetting(args[0], nil, true)
		},
	}
	command.AddCommand(show, path, set, unset)
	return command
}

func (s *commandState) changeSetting(key string, values []string, unset bool) error {
	current, err := s.currentContext()
	if err != nil {
		return err
	}
	if key == "app-password" {
		credentials, err := s.store.LoadCredentials()
		if err != nil {
			return err
		}
		entry := credentials[current.Name]
		if unset {
			if current.Spec.Driver != DriverLocal {
				return fmt.Errorf("a %s deployment always requires an app password; set a new one instead", current.Spec.Driver)
			}
			entry.AppPassword = ""
		} else if current.Spec.Driver == DriverExternal {
			return fmt.Errorf("context %q is managed outside uShelf; change the password where the server is deployed", current.Name)
		} else if entry.AppPassword, err = promptSecret(s.deps.Stdin, s.deps.Stderr, "App password", true); err != nil {
			return err
		}
		credentials[current.Name] = entry
		if err := s.store.SaveCredentials(credentials); err != nil {
			return err
		}
		s.actions().Done("App password updated for %s. Run ushelf start to apply it", current.Name)
		return nil
	}

	spec := current.Spec
	value := ""
	if !unset {
		value = values[0]
	}
	switch strings.ToLower(key) {
	case "image":
		spec.Image = value
	case "base-path":
		spec.BasePath = ""
		if value != "" {
			spec.BasePath = normalizeBasePath(value)
		}
	case "host":
		spec.Host = value
	case "port":
		spec.Port = 0
		if value != "" {
			port, err := strconv.Atoi(value)
			if err != nil {
				return fmt.Errorf("invalid port: %w", err)
			}
			spec.Port = port
		}
	case "domain":
		spec.Domain = value
		if value != "" {
			spec.URL = ""
		}
	case "url":
		spec.URL = normalizeOptionalURL(value)
		if value != "" {
			spec.Domain = ""
		}
	case "region":
		spec.Region = value
	default:
		return fmt.Errorf("unknown config key %q; use %s", key, strings.Join(configKeyNames, ", "))
	}
	if err := spec.Validate(); err != nil {
		return err
	}
	config, err := s.store.Load()
	if err != nil {
		return err
	}
	config.Contexts[current.Name] = spec
	if err := s.store.Save(config); err != nil {
		return err
	}
	if unset {
		s.actions().Done("Restored %s to its default for %s. Run ushelf start to apply it", key, current.Name)
	} else {
		s.actions().Done("Set %s to %s for %s. Run ushelf start to apply it", key, value, current.Name)
	}
	return nil
}
