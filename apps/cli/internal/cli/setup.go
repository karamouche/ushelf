package cli

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func (s *commandState) setupClients(ctx context.Context, client string, printOnly, force bool) error {
	executable, err := executablePath()
	if err != nil {
		return fmt.Errorf("resolve ushelf executable: %w", err)
	}
	clients := []string{client}
	if client == "all" {
		clients = []string{"codex", "claude-code"}
	}
	if client == "chatgpt" || client == "claude-desktop" {
		if s.settings.ActiveTarget != "remote" {
			return fmt.Errorf("%s requires an active remote target; run `ushelf connect URL` first", client)
		}
		connectionsURL := strings.TrimSuffix(s.settings.RemoteURL, "/") + "/connections"
		fmt.Fprintf(s.deps.Stdout, "Open %s and add %s with MCP URL %s/mcp\n", connectionsURL, client, strings.TrimSuffix(s.settings.RemoteURL, "/"))
		return nil
	}
	if printOnly {
		for _, current := range clients {
			fmt.Fprintln(s.deps.Stdout, setupCommandLine(current, executable, s.settings.Home))
		}
		return nil
	}
	actions := s.actions()
	actions.Step("Preparing uShelf agent assets...")
	var skillsRoot string
	if s.settings.ActiveTarget == "local" {
		docker := s.docker()
		if err := docker.EnsureDirectories(); err != nil {
			return err
		}
		if err := docker.EnsureImage(ctx); err != nil {
			return err
		}
		var err error
		skillsRoot, err = docker.ExtractSkills(ctx)
		if err != nil {
			return err
		}
	} else {
		var err error
		skillsRoot, err = s.extractRemoteSkills(ctx)
		if err != nil {
			return err
		}
	}
	for _, current := range clients {
		actions.Step("Configuring %s...", current)
		if err := s.configureClient(ctx, current, executable, force); err != nil {
			return err
		}
		if skillsRoot != "" {
			if err := linkSkills(current, skillsRoot, force); err != nil {
				return err
			}
		}
		actions.Done("Configured %s for uShelf", current)
	}
	if client == "all" && s.settings.ActiveTarget == "remote" {
		fmt.Fprintf(s.deps.Stdout, "Desktop clients: open %s/connections for ChatGPT and Claude Desktop.\n", strings.TrimSuffix(s.settings.RemoteURL, "/"))
	}
	return nil
}

func (s *commandState) extractRemoteSkills(ctx context.Context) (string, error) {
	version := strings.TrimPrefix(s.settings.Version, "v")
	if version == "" {
		version = "dev"
	}
	target := filepath.Join(s.settings.Home, "assets", version, "skills")
	if _, err := os.Stat(target); err == nil {
		return target, nil
	}
	response, err := s.remoteRequest(ctx, "GET", "/api/remote/skills", "", nil)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", remoteHTTPError("download agent skills", response)
	}
	archive, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return "", err
	}
	temporary := target + ".tmp"
	_ = os.RemoveAll(temporary)
	if err := os.MkdirAll(temporary, 0o700); err != nil {
		return "", err
	}
	if err := untarSkills(archive, temporary); err != nil {
		_ = os.RemoveAll(temporary)
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, target); err != nil {
		return "", err
	}
	return target, nil
}

func (s *commandState) configureClient(ctx context.Context, client, executable string, force bool) error {
	commandName := clientCommand(client)
	getArgs := []string{"mcp", "get", "ushelf"}
	if client == "codex" {
		getArgs = append(getArgs, "--json")
	}
	existing, getErr := s.deps.Runner.Output(ctx, commandName, getArgs...)
	if getErr == nil {
		matches, matchErr := clientConfigurationMatches(client, existing, executable, s.settings.Home)
		if matchErr != nil && !force {
			return fmt.Errorf("inspect existing %s uShelf MCP entry: %w", client, matchErr)
		}
		if matchErr == nil && matches {
			return nil
		}
		if !force {
			return fmt.Errorf("%s already has a conflicting uShelf MCP entry; inspect it or rerun with --force", client)
		}
		if err := runQuiet(ctx, s.deps.Runner, commandName, "mcp", "remove", "ushelf"); err != nil {
			return err
		}
	}
	args := []string{"mcp", "add"}
	if client == "claude-code" {
		args = append(args, "--scope", "user")
	}
	args = append(args, "ushelf", "--", executable, "--home", s.settings.Home, "mcp")
	return runQuiet(ctx, s.deps.Runner, commandName, args...)
}

func clientConfigurationMatches(client, output, executable, home string) (bool, error) {
	expectedArgs := []string{"--home", home, "mcp"}
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

func setupCommandLine(client, executable, home string) string {
	prefix := clientCommand(client) + " mcp add"
	if client == "claude-code" {
		prefix += " --scope user"
	}
	return fmt.Sprintf("%s ushelf -- %q --home %q mcp", prefix, executable, home)
}

func (d Docker) ExtractSkills(ctx context.Context) (string, error) {
	version := strings.TrimPrefix(d.Settings.Version, "v")
	if version == "" {
		version = "dev"
	}
	target := filepath.Join(d.assetsDir(), version, "skills")
	if _, err := os.Stat(target); err == nil {
		return target, nil
	}
	d.step("Extracting bundled agent skills...")
	archive, err := d.Runner.Output(ctx, "docker", "run", "--rm", "--entrypoint", "tar", d.Settings.Image, "-C", "/opt/ushelf/skills", "-cf", "-", ".")
	if err != nil {
		return "", fmt.Errorf("extract skills from image: %w", err)
	}
	temporary := target + ".tmp"
	_ = os.RemoveAll(temporary)
	if err := os.MkdirAll(temporary, 0o700); err != nil {
		return "", err
	}
	if err := untarSkills([]byte(archive), temporary); err != nil {
		_ = os.RemoveAll(temporary)
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, target); err != nil {
		return "", err
	}
	return target, nil
}

func untarSkills(archive []byte, target string) error {
	reader := tar.NewReader(bytes.NewReader(archive))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read skills archive: %w", err)
		}
		name := filepath.Clean(strings.TrimPrefix(header.Name, "./"))
		if name == "." {
			continue
		}
		path := filepath.Join(target, name)
		relative, err := filepath.Rel(target, path)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe path in skills archive: %s", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return err
			}
			contents, err := io.ReadAll(reader)
			if err != nil {
				return err
			}
			if err := os.WriteFile(path, contents, 0o600); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported entry in skills archive: %s", header.Name)
		}
	}
}

func linkSkills(client, sourceRoot string, force bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	destinationRoot := filepath.Join(home, ".agents", "skills")
	if client == "claude-code" {
		destinationRoot = filepath.Join(home, ".claude", "skills")
	}
	if err := os.MkdirAll(destinationRoot, 0o700); err != nil {
		return err
	}
	for _, name := range []string{"ushelf-ingest", "ushelf-library"} {
		source := filepath.Join(sourceRoot, name)
		if info, err := os.Stat(source); err != nil || !info.IsDir() {
			return fmt.Errorf("skill %s is missing from runtime image", name)
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

func clientCommand(client string) string {
	if client == "claude-code" {
		return "claude"
	}
	return client
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
