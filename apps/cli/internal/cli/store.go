package cli

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/karamouche/ushelf/apps/cli/internal/api"
)

// Driver names how a context's server is deployed and operated.
type Driver string

const (
	DriverLocal    Driver = "local"
	DriverSSH      Driver = "ssh"
	DriverFly      Driver = "fly"
	DriverExternal Driver = "external"
)

const (
	defaultHost     = "127.0.0.1"
	defaultPort     = 43110
	defaultBasePath = "/"
)

var (
	safeBasePath = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$`)
	contextName  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
	flyAppName   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	flyRegion    = regexp.MustCompile(`^[a-z]{3}$`)
	domainName   = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	sshTarget    = regexp.MustCompile(`^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(:[0-9]{1,5})?$`)
)

// ContextSpec is the persisted description of one uShelf server.
type ContextSpec struct {
	Driver   Driver `json:"driver"`
	URL      string `json:"url,omitempty"`
	Image    string `json:"image,omitempty"`
	BasePath string `json:"basePath,omitempty"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	SSH      string `json:"ssh,omitempty"`
	Domain   string `json:"domain,omitempty"`
	App      string `json:"app,omitempty"`
	Region   string `json:"region,omitempty"`
	Org      string `json:"org,omitempty"`
}

// Credentials are kept apart from config.json so configuration can be shared or printed safely.
type Credentials struct {
	APIToken    string `json:"apiToken"`
	AppPassword string `json:"appPassword,omitempty"`
}

type fileConfig struct {
	CurrentContext string                 `json:"currentContext,omitempty"`
	Contexts       map[string]ContextSpec `json:"contexts,omitempty"`
}

// Store owns the CLI's files under the uShelf home.
type Store struct{ Home string }

func ResolveHome(flag string) (string, error) {
	home := flag
	if home == "" {
		home = os.Getenv("USHELF_ROOT")
	}
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		home = filepath.Join(userHome, ".ushelf")
	}
	absolute, err := filepath.Abs(home)
	if err != nil {
		return "", fmt.Errorf("resolve uShelf home: %w", err)
	}
	return absolute, nil
}

func (s Store) ConfigPath() string      { return filepath.Join(s.Home, "config.json") }
func (s Store) CredentialsPath() string { return filepath.Join(s.Home, "credentials.json") }

func (s Store) Load() (fileConfig, error) {
	var config fileConfig
	if err := readJSON(s.ConfigPath(), &config); err != nil {
		return fileConfig{}, err
	}
	if config.Contexts == nil {
		config.Contexts = map[string]ContextSpec{}
	}
	return config, nil
}

func (s Store) Save(config fileConfig) error { return writeJSON(s.ConfigPath(), config) }

func (s Store) LoadCredentials() (map[string]Credentials, error) {
	credentials := map[string]Credentials{}
	if err := readJSON(s.CredentialsPath(), &credentials); err != nil {
		return nil, err
	}
	return credentials, nil
}

func (s Store) SaveCredentials(credentials map[string]Credentials) error {
	return writeJSON(s.CredentialsPath(), credentials)
}

// Context is a resolved context: its spec, secrets, and the CLI build it runs under.
type Context struct {
	Name        string
	Spec        ContextSpec
	Credentials Credentials
	Home        string
	Version     string
}

func (c Context) Managed() bool { return c.Spec.Driver != DriverExternal }

func (c Context) Image() string { return firstNonEmpty(c.Spec.Image, defaultImage(c.Version)) }

func (c Context) BasePath() string {
	return normalizeBasePath(firstNonEmpty(c.Spec.BasePath, defaultBasePath))
}

func (c Context) Host() string { return firstNonEmpty(c.Spec.Host, defaultHost) }

func (c Context) Port() int { return firstNonZero(c.Spec.Port, defaultPort) }

// URL is where the CLI, agents, and browser reach this context's server.
func (c Context) URL() string {
	base := strings.TrimSuffix(c.BasePath(), "/") + "/"
	switch c.Spec.Driver {
	case DriverLocal:
		host := c.Host()
		if ip := net.ParseIP(host); host == "localhost" || ip != nil && ip.IsUnspecified() {
			host = defaultHost
		}
		return fmt.Sprintf("http://%s%s", net.JoinHostPort(host, strconv.Itoa(c.Port())), base)
	case DriverSSH:
		if c.Spec.Domain != "" {
			return "https://" + c.Spec.Domain + base
		}
		return c.Spec.URL
	case DriverFly:
		return "https://" + c.Spec.App + ".fly.dev" + base
	default:
		return c.Spec.URL
	}
}

func (c Context) Client() (*api.Client, error) {
	if c.Credentials.APIToken == "" {
		return nil, fmt.Errorf("context %q has no API token; run `ushelf context add %s --url URL` or redeploy it", c.Name, c.Name)
	}
	return api.New(c.URL(), c.Credentials.APIToken)
}

func validateContextName(name string) error {
	if !contextName.MatchString(name) {
		return fmt.Errorf("context name %q must use lowercase letters, digits, '.', '_' or '-'", name)
	}
	return nil
}

// Validate checks the fields each driver relies on and rejects fields it would ignore.
func (s ContextSpec) Validate() error {
	if s.Image != "" && strings.ContainsAny(s.Image, " \t\r\n") {
		return fmt.Errorf("image must be a Docker image reference")
	}
	if basePath := firstNonEmpty(s.BasePath, defaultBasePath); !strings.HasPrefix(basePath, "/") || strings.HasPrefix(basePath, "//") || !safeBasePath.MatchString(basePath) {
		return fmt.Errorf("base path must be a safe absolute URL path")
	}
	if s.Port != 0 && (s.Port < 1 || s.Port > 65535) {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if s.Host != "" && net.ParseIP(s.Host) == nil && s.Host != "localhost" {
		return fmt.Errorf("host must be an IP address or localhost")
	}
	unexpected := func(field string, set bool) error {
		if set {
			return fmt.Errorf("%s is not used by the %s driver", field, s.Driver)
		}
		return nil
	}
	switch s.Driver {
	case DriverLocal:
		return errors.Join(unexpected("url", s.URL != ""), unexpected("ssh", s.SSH != ""), unexpected("domain", s.Domain != ""),
			unexpected("app", s.App != ""), unexpected("region", s.Region != ""), unexpected("org", s.Org != ""))
	case DriverSSH:
		if !sshTarget.MatchString(s.SSH) {
			return fmt.Errorf("ssh target must look like user@host or user@host:port")
		}
		if (s.Domain == "") == (s.URL == "") {
			return fmt.Errorf("an ssh deployment needs exactly one of --domain (managed HTTPS) or --url (your own proxy)")
		}
		if s.Domain != "" && !domainName.MatchString(s.Domain) {
			return fmt.Errorf("domain %q is not a valid DNS name", s.Domain)
		}
		if s.URL != "" {
			if _, err := api.ParseBaseURL(s.URL); err != nil {
				return err
			}
		}
		return errors.Join(unexpected("app", s.App != ""), unexpected("region", s.Region != ""), unexpected("org", s.Org != ""))
	case DriverFly:
		if !flyAppName.MatchString(s.App) {
			return fmt.Errorf("fly app name must use lowercase letters, digits, and '-'")
		}
		if !flyRegion.MatchString(s.Region) {
			return fmt.Errorf("fly region must be a three-letter region code such as cdg or iad")
		}
		return errors.Join(unexpected("url", s.URL != ""), unexpected("ssh", s.SSH != ""), unexpected("domain", s.Domain != ""),
			unexpected("host", s.Host != ""), unexpected("port", s.Port != 0))
	case DriverExternal:
		if _, err := api.ParseBaseURL(s.URL); err != nil {
			return err
		}
		return errors.Join(unexpected("image", s.Image != ""), unexpected("base-path", s.BasePath != ""), unexpected("host", s.Host != ""),
			unexpected("port", s.Port != 0), unexpected("ssh", s.SSH != ""), unexpected("domain", s.Domain != ""),
			unexpected("app", s.App != ""), unexpected("region", s.Region != ""), unexpected("org", s.Org != ""))
	default:
		return fmt.Errorf("unknown driver %q", s.Driver)
	}
}

func newAPIToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate API token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func normalizeURL(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return value
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	return parsed.String()
}

func readJSON(path string, target any) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

func writeJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(raw, '\n'), 0o600)
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
