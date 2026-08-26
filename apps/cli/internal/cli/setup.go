package cli

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func (s *commandState) setupClients(ctx context.Context, client string, printOnly, force bool) error {
	executable, err := executablePath()
	if err != nil {
		return fmt.Errorf("resolve ushelf executable: %w", err)
	}
	clients := []string{client}
	if client == "all" {
		clients = []string{"codex", "claude"}
	}
	if printOnly {
		for _, current := range clients {
			fmt.Fprintln(s.deps.Stdout, setupCommandLine(current, executable, s.settings.Home))
		}
		return nil
	}
	docker := s.docker()
	if err := docker.EnsureDirectories(); err != nil {
		return err
	}
	if err := docker.EnsureImage(ctx); err != nil {
		return err
	}
	skillsRoot, err := docker.ExtractSkills(ctx)
	if err != nil {
		return err
	}
	for _, current := range clients {
		if err := s.configureClient(ctx, current, executable, force); err != nil {
			return err
		}
		if err := linkSkills(current, skillsRoot, force); err != nil {
			return err
		}
		fmt.Fprintf(s.deps.Stdout, "Configured %s for uShelf.\n", current)
	}
	return nil
}

func (s *commandState) configureClient(ctx context.Context, client, executable string, force bool) error {
	getArgs := []string{"mcp", "get", "ushelf"}
	existing, getErr := s.deps.Runner.Output(ctx, client, getArgs...)
	if getErr == nil {
		if strings.Contains(existing, executable) && strings.Contains(existing, "mcp") {
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
	args = append(args, "ushelf", "--", executable, "--home", s.settings.Home, "mcp")
	return s.deps.Runner.Run(ctx, nil, s.deps.Stdout, s.deps.Stderr, client, args...)
}

func setupCommandLine(client, executable, home string) string {
	prefix := client + " mcp add"
	if client == "claude" {
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
	if client == "claude" {
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
