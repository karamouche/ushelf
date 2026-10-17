package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/karamouche/ushelf/apps/cli/internal/api"
	"github.com/spf13/cobra"
)

var skillName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

func (s *commandState) setupCommand() *cobra.Command {
	var printOnly, force bool
	command := &cobra.Command{
		Use:   "setup codex|claude|all",
		Short: "Connect an agent client to the current context and install uShelf skills",
		Long: "Register `ushelf mcp` with Codex, Claude Code, or both, pinned to the current\n" +
			"context, and link the skills published by that context's server.",
		Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			client := strings.ToLower(args[0])
			if client != "codex" && client != "claude" && client != "all" {
				return fmt.Errorf("client must be codex, claude, or all")
			}
			return s.setupClients(command.Context(), client, printOnly, force)
		},
	}
	command.Flags().BoolVar(&printOnly, "print", false, "print setup commands without making changes")
	command.Flags().BoolVar(&force, "force", false, "replace conflicting uShelf entries and skill links")
	return command
}

func (s *commandState) setupClients(ctx context.Context, client string, printOnly, force bool) error {
	current, err := s.currentContext()
	if err != nil {
		return err
	}
	executable, err := executablePath()
	if err != nil {
		return fmt.Errorf("resolve ushelf executable: %w", err)
	}
	clients := []string{client}
	if client == "all" {
		clients = []string{"codex", "claude"}
	}
	registration := mcpRegistration{Executable: executable, Home: s.store.Home, Context: current.Name}
	if printOnly {
		for _, current := range clients {
			fmt.Fprintln(s.deps.Stdout, registration.commandLine(current))
		}
		return nil
	}
	actions := s.actions()
	actions.Step("Fetching agent skills from %s...", current.URL())
	apiClient, err := current.Client()
	if err != nil {
		return err
	}
	bundle, err := apiClient.Skills(ctx)
	if err != nil {
		return fmt.Errorf("fetch agent skills: %w", err)
	}
	skillsRoot, err := installSkills(s.assetsDir(), bundle)
	if err != nil {
		return err
	}
	for _, name := range clients {
		actions.Step("Configuring %s...", name)
		if err := s.configureClient(ctx, name, registration, force); err != nil {
			return err
		}
		if err := linkSkills(name, skillsRoot, force); err != nil {
			return err
		}
		actions.Done("Configured %s for uShelf context %s", name, current.Name)
	}
	return nil
}

func (s *commandState) assetsDir() string { return filepath.Join(s.store.Home, "assets") }

// mcpRegistration is the exact command agent clients run; it pins the context so
// switching the current context never silently retargets a configured agent.
type mcpRegistration struct {
	Executable, Home, Context string
}

func (r mcpRegistration) args() []string {
	return []string{"--home", r.Home, "--context", r.Context, "mcp"}
}

func (r mcpRegistration) commandLine(client string) string {
	prefix := client + " mcp add"
	if client == "claude" {
		prefix += " --scope user"
	}
	return fmt.Sprintf("%s ushelf -- %q --home %q --context %q mcp", prefix, r.Executable, r.Home, r.Context)
}

func (s *commandState) configureClient(ctx context.Context, client string, registration mcpRegistration, force bool) error {
	getArgs := []string{"mcp", "get", "ushelf"}
	if client == "codex" {
		getArgs = append(getArgs, "--json")
	}
	existing, getErr := s.deps.Runner.Output(ctx, client, getArgs...)
	if getErr == nil {
		matches, matchErr := clientConfigurationMatches(client, existing, registration)
		if matchErr != nil && !force {
			return fmt.Errorf("inspect existing %s uShelf MCP entry: %w", client, matchErr)
		}
		if matchErr == nil && matches {
			return nil
		}
		if !force {
			return fmt.Errorf("%s already has a conflicting uShelf MCP entry; inspect it or rerun with --force", client)
		}
		if err := runQuiet(ctx, s.deps.Runner, client, "mcp", "remove", "ushelf"); err != nil {
			return err
		}
	}
	args := []string{"mcp", "add"}
	if client == "claude" {
		args = append(args, "--scope", "user")
	}
	args = append(args, "ushelf", "--", registration.Executable)
	args = append(args, registration.args()...)
	return runQuiet(ctx, s.deps.Runner, client, args...)
}

func clientConfigurationMatches(client, output string, registration mcpRegistration) (bool, error) {
	executable, expectedArgs := registration.Executable, registration.args()
	if client == "codex" {
		var config struct {
			Transport struct {
				Type    string   `json:"type"`
				Command string   `json:"command"`
				Args    []string `json:"args"`
			} `json:"transport"`
		}
		if err := json.Unmarshal([]byte(output), &config); err != nil {
			return false, fmt.Errorf("parse Codex MCP configuration: %w", err)
		}
		return config.Transport.Type == "stdio" &&
			config.Transport.Command == executable &&
			slices.Equal(config.Transport.Args, expectedArgs), nil
	}

	command, args, err := parseClaudeMCPConfiguration(output)
	if err != nil {
		return false, err
	}
	return command == executable && args == strings.Join(expectedArgs, " "), nil
}

func parseClaudeMCPConfiguration(output string) (string, string, error) {
	var command, args string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "Command:"):
			command = strings.TrimSpace(strings.TrimPrefix(line, "Command:"))
		case strings.HasPrefix(line, "Args:"):
			args = strings.TrimSpace(strings.TrimPrefix(line, "Args:"))
		}
	}
	if command == "" || args == "" {
		return "", "", fmt.Errorf("parse Claude MCP configuration: missing Command or Args")
	}
	return command, args, nil
}

// installSkills writes a server's skill bundle under the CLI assets directory and
// returns the directory that holds one subdirectory per skill.
func installSkills(assetsRoot string, bundle api.SkillBundle) (string, error) {
	version := strings.TrimPrefix(bundle.Version, "v")
	if version == "" || strings.ContainsAny(version, `/\`) || version == "." || version == ".." {
		return "", fmt.Errorf("server reported an invalid version %q", bundle.Version)
	}
	target := filepath.Join(assetsRoot, "skills", version)
	temporary, err := os.MkdirTemp(filepath.Dir(target), ".skills-*")
	if errors.Is(err, os.ErrNotExist) {
		if err = os.MkdirAll(filepath.Dir(target), 0o700); err == nil {
			temporary, err = os.MkdirTemp(filepath.Dir(target), ".skills-*")
		}
	}
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(temporary)
	for _, skill := range bundle.Skills {
		if !skillName.MatchString(skill.Name) {
			return "", fmt.Errorf("server returned an invalid skill name %q", skill.Name)
		}
		for _, file := range skill.Files {
			relative := filepath.FromSlash(file.Path)
			if file.Path == "" || filepath.IsAbs(relative) || !filepath.IsLocal(relative) {
				return "", fmt.Errorf("server returned an unsafe skill path %q", file.Path)
			}
			path := filepath.Join(temporary, skill.Name, relative)
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return "", err
			}
			if err := os.WriteFile(path, []byte(file.Content), 0o600); err != nil {
				return "", err
			}
		}
	}
	// Replace the whole version directory so files removed upstream disappear locally.
	if err := os.RemoveAll(target); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, target); err != nil {
		return "", err
	}
	return target, nil
}

func linkSkills(client, sourceRoot string, force bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	destinationRoot := filepath.Join(home, ".agents", "skills")
	if client == "claude" {
		destinationRoot = filepath.Join(home, ".claude", "skills")
	}
	if err := os.MkdirAll(destinationRoot, 0o700); err != nil {
		return err
	}
	for _, name := range []string{"ushelf-ingest", "ushelf-library"} {
		source := filepath.Join(sourceRoot, name)
		if info, err := os.Stat(source); err != nil || !info.IsDir() {
			return fmt.Errorf("skill %s is missing from the server's skill bundle", name)
		}
		destination := filepath.Join(destinationRoot, name)
		current, err := os.Readlink(destination)
		if err == nil && current == source {
			continue
		}
		if err == nil || !errors.Is(err, os.ErrNotExist) {
			if !force {
				return fmt.Errorf("%s already exists; rerun with --force to replace it", destination)
			}
			if err := os.RemoveAll(destination); err != nil {
				return err
			}
		}
		if err := replaceSymlink(source, destination); err != nil {
			return err
		}
	}
	return nil
}

func replaceSymlink(source, destination string) error {
	temporary := destination + ".tmp"
	if err := os.Remove(temporary); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Symlink(source, temporary); err != nil {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}
