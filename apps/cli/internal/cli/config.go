package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	defaultHost     = "127.0.0.1"
	defaultPort     = 43110
	defaultBasePath = "/"
)

var safeBasePath = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$`)

type fileConfig struct {
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	BasePath string `json:"basePath,omitempty"`
	Image    string `json:"image,omitempty"`
}

type Settings struct {
	Home       string
	Host       string
	Port       int
	BasePath   string
	Image      string
	Version    string
	ConfigPath string
}

type FlagValues struct {
	Home, Host, Port, BasePath, Image string
	Changed                           func(string) bool
}

func ResolveSettings(flags FlagValues, version string) (Settings, error) {
	home := flags.Home
	if home == "" {
		home = os.Getenv("USHELF_ROOT")
	}
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return Settings{}, fmt.Errorf("resolve home directory: %w", err)
		}
		home = filepath.Join(userHome, ".ushelf")
	}
	absHome, err := filepath.Abs(home)
	if err != nil {
		return Settings{}, fmt.Errorf("resolve uShelf home: %w", err)
	}

	configPath := filepath.Join(absHome, "config.json")
	stored, err := readFileConfig(configPath)
	if err != nil {
		return Settings{}, err
	}
	settings := Settings{
		Home:       absHome,
		Host:       firstNonEmpty(stored.Host, defaultHost),
		Port:       firstNonZero(stored.Port, defaultPort),
		BasePath:   firstNonEmpty(stored.BasePath, defaultBasePath),
		Image:      firstNonEmpty(stored.Image, defaultImage(version)),
		Version:    version,
		ConfigPath: configPath,
	}
	if value := os.Getenv("USHELF_HOST"); value != "" {
		settings.Host = value
	}
	if value := os.Getenv("USHELF_PORT"); value != "" {
		port, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			return Settings{}, fmt.Errorf("invalid USHELF_PORT: %w", parseErr)
		}
		settings.Port = port
	}
	if value := os.Getenv("USHELF_WEB_BASE_PATH"); value != "" {
		settings.BasePath = value
	}
	if value := os.Getenv("USHELF_IMAGE"); value != "" {
		settings.Image = value
	}
	if flags.Changed != nil {
		if flags.Changed("host") {
			settings.Host = flags.Host
		}
		if flags.Changed("port") {
			port, parseErr := strconv.Atoi(flags.Port)
			if parseErr != nil {
				return Settings{}, fmt.Errorf("invalid --port: %w", parseErr)
			}
			settings.Port = port
		}
		if flags.Changed("base-path") {
			settings.BasePath = flags.BasePath
		}
		if flags.Changed("image") {
			settings.Image = flags.Image
		}
	}
	settings.BasePath = normalizeBasePath(settings.BasePath)
	if err := settings.Validate(); err != nil {
		return Settings{}, err
	}
	return settings, nil
}

func (s Settings) Validate() error {
	if s.Port < 1 || s.Port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if net.ParseIP(s.Host) == nil && s.Host != "localhost" {
		return fmt.Errorf("host must be an IP address or localhost")
	}
	if !strings.HasPrefix(s.BasePath, "/") || strings.HasPrefix(s.BasePath, "//") || !safeBasePath.MatchString(s.BasePath) {
		return fmt.Errorf("base path must be a safe absolute URL path")
	}
	if strings.TrimSpace(s.Image) == "" || strings.ContainsAny(s.Image, " \t\r\n") {
		return fmt.Errorf("image must be a non-empty Docker image reference")
	}
	return nil
}

func (s Settings) URL() string {
	base := strings.TrimSuffix(s.BasePath, "/")
	return fmt.Sprintf("http://%s%s/", net.JoinHostPort(s.Host, strconv.Itoa(s.Port)), base)
}

func readFileConfig(path string) (fileConfig, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fileConfig{}, nil
	}
	if err != nil {
		return fileConfig{}, fmt.Errorf("read config: %w", err)
	}
	var config fileConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return fileConfig{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return config, nil
}

func writeFileConfig(path string, config fileConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

func defaultImage(version string) string {
	if version == "" || version == "dev" {
		return "ghcr.io/karamouche/ushelf:latest"
	}
	return "ghcr.io/karamouche/ushelf:" + strings.TrimPrefix(version, "v")
}

func normalizeBasePath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return "/"
	}
	return "/" + strings.Trim(value, "/") + "/"
}

func firstNonEmpty(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func firstNonZero(value, fallback int) int {
	if value != 0 {
		return value
	}
	return fallback
}
