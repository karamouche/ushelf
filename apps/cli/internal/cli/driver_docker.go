package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	containerName      = "ushelf"
	proxyContainerName = "ushelf-caddy"
	dataVolume         = "ushelf-data"
	proxyDataVolume    = "ushelf-caddy-data"
	networkName        = "ushelf"
	// Pinned by multi-arch digest; Dependabot cannot see this reference, so bump it by hand.
	proxyImage = "caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb"
	// imageUser is the node user baked into the runtime image; remote volumes are seeded with its ownership.
	imageUser = "1000:1000"
)

var (
	healthTimeout      = 45 * time.Second
	healthPollInterval = 500 * time.Millisecond
)

// DockerDeployment runs the server with a Docker daemon: the local one for the local
// driver, or a remote one reached over SSH for the ssh driver.
type DockerDeployment struct {
	Context Context
	Runner  Runner
	Stdout  io.Writer
	Stderr  io.Writer
	Actions *actionReporter
}

func (d DockerDeployment) remote() bool { return d.Context.Spec.Driver == DriverSSH }

func (d DockerDeployment) args(args ...string) []string {
	if d.remote() {
		return append([]string{"--host", "ssh://" + d.Context.Spec.SSH}, args...)
	}
	return args
}

func (d DockerDeployment) output(ctx context.Context, args ...string) (string, error) {
	return d.Runner.Output(ctx, "docker", d.args(args...)...)
}

func (d DockerDeployment) run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, args ...string) error {
	return d.Runner.Run(ctx, stdin, stdout, stderr, "docker", d.args(args...)...)
}

func (d DockerDeployment) runQuiet(ctx context.Context, args ...string) error {
	var output bytes.Buffer
	if err := d.run(ctx, nil, &output, &output, args...); err != nil {
		if detail := strings.TrimSpace(output.String()); detail != "" {
			return fmt.Errorf("%w: %s", err, detail)
		}
		return err
	}
	return nil
}

func (d DockerDeployment) Apply(ctx context.Context) error {
	if d.remote() {
		d.step("Connecting to Docker on %s...", d.Context.Spec.SSH)
	} else {
		d.step("Preparing the uShelf home at %s...", d.Context.Home)
		if err := d.EnsureDirectories(); err != nil {
			return err
		}
	}
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	if d.remote() {
		if err := d.runQuiet(ctx, "volume", "create", "--label", "io.ushelf.managed=true", dataVolume); err != nil {
			return err
		}
		if d.Context.Spec.Domain != "" {
			if err := d.ensureNetwork(ctx); err != nil {
				return err
			}
		}
	} else if err := d.SeedRecipe(ctx); err != nil {
		return err
	}
	if err := d.applyServer(ctx); err != nil {
		return err
	}
	if d.remote() && d.Context.Spec.Domain != "" {
		return d.applyProxy(ctx)
	}
	if d.remote() {
		return d.removeManaged(ctx, proxyContainerName)
	}
	return nil
}

func (d DockerDeployment) applyServer(ctx context.Context) error {
	hash := d.configHash()
	envFile, cleanup, err := d.secretEnvFile()
	if err != nil {
		return err
	}
	defer cleanup()
	args := []string{"run", "-d", "--name", containerName,
		"--label", "io.ushelf.managed=true", "--label", "io.ushelf.config=" + hash,
		"--init", "--restart", "unless-stopped", "--read-only", "--tmpfs", "/tmp",
		"--security-opt", "no-new-privileges:true", "--user", d.user(),
		"-e", "NODE_ENV=production", "-e", "USHELF_ROOT=/data",
		"-e", "USHELF_KINDLE_BRIDGE=/app/bin/ushelf-kindle-bridge",
		"-e", "USHELF_HOST=0.0.0.0", "-e", "USHELF_PORT=" + strconv.Itoa(d.Context.Port()),
		"-e", "USHELF_WEB_BASE_PATH=" + d.Context.BasePath(),
		"--env-file", envFile}
	args = append(args, d.dataMounts(true)...)
	if d.remote() && d.Context.Spec.Domain != "" {
		args = append(args, "--network", networkName)
	} else {
		args = append(args, "-e", "USHELF_PUBLISHED_HOST="+d.publishHost(),
			"-p", fmt.Sprintf("%s:%d", net.JoinHostPort(d.publishHost(), strconv.Itoa(d.Context.Port())), d.Context.Port()))
	}
	args = append(args, d.Context.Image())
	if err := d.reconcile(ctx, containerName, hash, "uShelf service", args); err != nil {
		return err
	}
	return d.waitForHealth(ctx)
}

// applyProxy runs Caddy in front of the server with automatic Let's Encrypt certificates.
func (d DockerDeployment) applyProxy(ctx context.Context) error {
	upstream := fmt.Sprintf("%s:%d", containerName, d.Context.Port())
	hash := hashValues(proxyImage, d.Context.Spec.Domain, upstream)
	if _, err := d.output(ctx, "image", "inspect", proxyImage); err != nil {
		d.step("Downloading the HTTPS proxy image %s...", proxyImage)
		if err := d.runQuiet(ctx, "pull", proxyImage); err != nil {
			return err
		}
	}
	args := []string{"run", "-d", "--name", proxyContainerName,
		"--label", "io.ushelf.managed=true", "--label", "io.ushelf.config=" + hash,
		"--restart", "unless-stopped", "--security-opt", "no-new-privileges:true",
		"--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE",
		"--network", networkName, "-p", "80:80", "-p", "443:443",
		"-v", proxyDataVolume + ":/data",
		proxyImage, "caddy", "reverse-proxy", "--from", d.Context.Spec.Domain, "--to", upstream}
	return d.reconcile(ctx, proxyContainerName, hash, "HTTPS proxy", args)
}

// reconcile keeps a container whose configuration label matches, and replaces it otherwise.
func (d DockerDeployment) reconcile(ctx context.Context, name, hash, label string, args []string) error {
	exists, err := d.managedContainerExists(ctx, name)
	if err != nil {
		return err
	}
	if exists {
		existingHash, err := d.inspect(ctx, name, `{{index .Config.Labels "io.ushelf.config"}}`)
		if err != nil {
			return err
		}
		if strings.TrimSpace(existingHash) == hash {
			running, err := d.inspect(ctx, name, "{{.State.Running}}")
			if err != nil {
				return err
			}
			if strings.TrimSpace(running) == "true" {
				d.step("Checking the running %s...", label)
				return nil
			}
			d.step("Starting the existing %s...", label)
			return d.runQuiet(ctx, "start", name)
		}
		d.step("Recreating the %s for the current configuration...", label)
		if err := d.runQuiet(ctx, "rm", "-f", name); err != nil {
			return err
		}
	} else {
		d.step("Creating the %s...", label)
	}
	return d.runQuiet(ctx, args...)
}

func (d DockerDeployment) Stop(ctx context.Context) error {
	stopped := false
	for _, name := range []string{proxyContainerName, containerName} {
		exists, err := d.managedContainerExists(ctx, name)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		if !stopped {
			d.step("Stopping the uShelf service...")
		}
		stopped = true
		if err := d.runQuiet(ctx, "rm", "-f", name); err != nil {
			return err
		}
	}
	if !stopped {
		d.done("uShelf is already stopped")
		return nil
	}
	d.done("uShelf stopped; your library is unchanged")
	return nil
}

func (d DockerDeployment) State(ctx context.Context) (string, error) {
	exists, err := d.managedContainerExists(ctx, containerName)
	if err != nil {
		return "", err
	}
	if !exists {
		return "stopped", nil
	}
	value, err := d.inspect(ctx, containerName, "{{json .State}}")
	if err != nil {
		return "", err
	}
	var state struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(value)), &state); err != nil {
		return "", fmt.Errorf("parse Docker status: %w", err)
	}
	if state.Health != nil {
		return state.Status + " (" + state.Health.Status + ")", nil
	}
	return state.Status, nil
}

func (d DockerDeployment) IsRunning(ctx context.Context) (bool, error) {
	exists, err := d.managedContainerExists(ctx, containerName)
	if err != nil || !exists {
		return false, err
	}
	value, err := d.inspect(ctx, containerName, "{{.State.Running}}")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(value) == "true", nil
}

func (d DockerDeployment) Logs(ctx context.Context, follow bool, tail int) error {
	exists, err := d.managedContainerExists(ctx, containerName)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("uShelf is not running")
	}
	args := []string{"logs", "--tail", strconv.Itoa(tail)}
	if follow {
		args = append(args, "--follow")
	}
	return d.run(ctx, nil, d.Stdout, d.Stderr, append(args, containerName)...)
}

func (d DockerDeployment) Diagnose(ctx context.Context, check func(string, error)) {
	_, err := d.output(ctx, "version", "--format", "{{.Server.Version}}")
	check("docker daemon", err)
	if !d.remote() {
		check("directories", d.EnsureDirectories())
		check("permissions", d.CheckWritable())
		check("port", d.CheckPort(ctx))
	}
	check("runtime image", d.EnsureImage(ctx))
	if !d.remote() {
		check("image architecture", d.CheckImageArchitecture(ctx))
		check("default recipe", d.SeedRecipe(ctx))
	}
	check("container health", d.CheckManagedHealth(ctx))
}

func (d DockerDeployment) RebuildIndex(ctx context.Context) error {
	if err := d.prepareMaintenance(ctx); err != nil {
		return err
	}
	command := append(d.oneShotArgs(), d.Context.Image(), "node", "apps/server/dist/cli.js", "rebuild-index")
	d.step("Running index maintenance...")
	if err := d.withServiceStopped(ctx, func() error {
		return d.run(ctx, nil, d.Stdout, d.Stderr, command...)
	}); err != nil {
		return err
	}
	d.done("Index rebuild completed")
	return nil
}

// Import streams the file over stdin so the same path works for local and remote daemons.
func (d DockerDeployment) Import(ctx context.Context, source string) error {
	absolute, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	file, err := os.Open(absolute)
	if err != nil {
		return fmt.Errorf("read import file: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("import path must be a regular file")
	}
	if err := d.prepareMaintenance(ctx); err != nil {
		return err
	}
	command := append(d.oneShotArgs(), "-i", d.Context.Image(), "sh", "-c",
		"cat > /tmp/import.md && exec node apps/server/dist/cli.js import /tmp/import.md")
	d.step("Importing %s...", absolute)
	if err := d.withServiceStopped(ctx, func() error {
		return d.run(ctx, file, d.Stdout, d.Stderr, command...)
	}); err != nil {
		return err
	}
	d.done("Markdown item imported")
	return nil
}

func (d DockerDeployment) prepareMaintenance(ctx context.Context) error {
	if !d.remote() {
		if err := d.EnsureDirectories(); err != nil {
			return err
		}
	}
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	if d.remote() {
		return nil
	}
	return d.SeedRecipe(ctx)
}

func (d DockerDeployment) withServiceStopped(ctx context.Context, operation func() error) error {
	wasRunning, err := d.IsRunning(ctx)
	if err != nil {
		return err
	}
	if wasRunning {
		d.step("Pausing the uShelf service...")
		if err := d.runQuiet(ctx, "stop", containerName); err != nil {
			return err
		}
	}
	operationErr := operation()
	if !wasRunning {
		return operationErr
	}
	d.step("Restoring the uShelf service...")
	restartErr := d.runQuiet(context.Background(), "start", containerName)
	return errors.Join(operationErr, restartErr)
}

// oneShotArgs never exposes integration secrets to maintenance containers.
func (d DockerDeployment) oneShotArgs() []string {
	args := []string{"run", "--rm", "--init", "--read-only", "--tmpfs", "/tmp", "--security-opt", "no-new-privileges:true",
		"--user", d.user(), "-e", "NODE_ENV=production", "-e", "USHELF_ROOT=/data"}
	args = append(args, d.dataMounts(false)...)
	if d.remote() {
		args = append(args, "--tmpfs", "/data/secrets")
	}
	return args
}

func (d DockerDeployment) dataMounts(withSecrets bool) []string {
	if d.remote() {
		return []string{"-v", dataVolume + ":/data"}
	}
	mounts := []string{"-v", d.libraryDir() + ":/data/library", "-v", d.recipesDir() + ":/data/recipes:ro", "-v", d.stateDir() + ":/data/state"}
	if withSecrets {
		mounts = append(mounts, "-v", d.secretsDir()+":/data/secrets")
	}
	return mounts
}

// secretEnvFile passes secrets to Docker without placing them on any command line.
func (d DockerDeployment) secretEnvFile() (string, func(), error) {
	if err := os.MkdirAll(d.Context.Home, 0o700); err != nil {
		return "", nil, err
	}
	file, err := os.CreateTemp(d.Context.Home, ".ushelf-env-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.Remove(file.Name()) }
	contents := "USHELF_API_TOKEN=" + d.Context.Credentials.APIToken + "\n"
	if d.Context.Credentials.AppPassword != "" {
		contents += "USHELF_APP_PASSWORD=" + d.Context.Credentials.AppPassword + "\n"
	}
	if err := file.Chmod(0o600); err == nil {
		_, err = file.WriteString(contents)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		cleanup()
		return "", nil, err
	}
	return file.Name(), cleanup, nil
}

func (d DockerDeployment) EnsureDirectories() error {
	for _, path := range []string{d.libraryDir(), d.itemsDir(), d.historyDir(), d.recipesDir(), d.stateDir(), d.assetsDir(), d.secretsDir()} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
	}
	return nil
}

func (d DockerDeployment) EnsureImage(ctx context.Context) error {
	if _, err := d.output(ctx, "image", "inspect", d.Context.Image()); err == nil {
		return nil
	}
	d.step("Downloading runtime image %s...", d.Context.Image())
	return d.runQuiet(ctx, "pull", d.Context.Image())
}

func (d DockerDeployment) SeedRecipe(ctx context.Context) error {
	target := filepath.Join(d.recipesDir(), "default.md")
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	d.step("Installing the default enrichment recipe...")
	if err := d.EnsureImage(ctx); err != nil {
		return err
	}
	contents, err := d.output(ctx, "run", "--rm", "--entrypoint", "cat", d.Context.Image(), "/opt/ushelf/recipes/default.md")
	if err != nil {
		return fmt.Errorf("read default recipe from image: %w", err)
	}
	return atomicWrite(target, []byte(contents), 0o600)
}

func (d DockerDeployment) ensureNetwork(ctx context.Context) error {
	if _, err := d.output(ctx, "network", "inspect", networkName); err == nil {
		return nil
	}
	return d.runQuiet(ctx, "network", "create", "--label", "io.ushelf.managed=true", networkName)
}

func (d DockerDeployment) removeManaged(ctx context.Context, name string) error {
	exists, err := d.managedContainerExists(ctx, name)
	if err != nil || !exists {
		return err
	}
	return d.runQuiet(ctx, "rm", "-f", name)
}

func (d DockerDeployment) waitForHealth(ctx context.Context) error {
	d.step("Waiting for uShelf to become ready...")
	deadline := time.Now().Add(healthTimeout)
	for time.Now().Before(deadline) {
		status, err := d.inspect(ctx, containerName, "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}")
		if err == nil {
			switch strings.TrimSpace(status) {
			case "healthy", "running":
				return nil
			case "unhealthy", "exited", "dead":
				return d.startupFailure(ctx, fmt.Errorf("uShelf container became %s", strings.TrimSpace(status)))
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(healthPollInterval):
		}
	}
	return d.startupFailure(ctx, errors.New("timed out waiting for uShelf health check"))
}

func (d DockerDeployment) startupFailure(ctx context.Context, cause error) error {
	var message strings.Builder
	message.WriteString(cause.Error())
	if logs, err := d.recentLogs(ctx, 20); err == nil && strings.TrimSpace(logs) != "" {
		message.WriteString("\n\nRecent service logs:\n")
		for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
			fmt.Fprintf(&message, "  %s\n", line)
		}
	}
	message.WriteString("\nNext steps:\n  ushelf logs --tail 200\n  ushelf doctor")
	return errors.New(message.String())
}

func (d DockerDeployment) recentLogs(ctx context.Context, tail int) (string, error) {
	var output bytes.Buffer
	err := d.run(ctx, nil, &output, &output, "logs", "--tail", strconv.Itoa(tail), containerName)
	return output.String(), err
}

func (d DockerDeployment) inspect(ctx context.Context, name, format string) (string, error) {
	return d.output(ctx, "inspect", "--format", format, name)
}

func (d DockerDeployment) managedContainerExists(ctx context.Context, name string) (bool, error) {
	names, err := d.output(ctx, "container", "ls", "--all", "--filter", "name="+name, "--format", "{{.Names}}")
	if err != nil {
		return false, fmt.Errorf("list Docker containers: %w", err)
	}
	exists := false
	for _, candidate := range strings.Fields(names) {
		if candidate == name {
			exists = true
			break
		}
	}
	if !exists {
		return false, nil
	}
	managed, err := d.inspect(ctx, name, `{{index .Config.Labels "io.ushelf.managed"}}`)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(managed) != "true" {
		return true, fmt.Errorf("Docker container %q exists but is not managed by the uShelf CLI", name)
	}
	return true, nil
}

// configHash covers every input that requires recreating the container, secrets included.
func (d DockerDeployment) configHash() string {
	return hashValues(d.Context.Image(), string(d.Context.Spec.Driver), d.Context.Home, d.Context.Spec.SSH, d.Context.Spec.Domain,
		d.Context.Host(), strconv.Itoa(d.Context.Port()), d.Context.BasePath(),
		d.Context.Credentials.APIToken, d.Context.Credentials.AppPassword)
}

func (d DockerDeployment) CheckPort(ctx context.Context) error {
	running, err := d.IsRunning(ctx)
	if err != nil {
		return err
	}
	if running {
		return nil
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(d.Context.Host(), strconv.Itoa(d.Context.Port())))
	if err != nil {
		return err
	}
	return listener.Close()
}

func (d DockerDeployment) CheckWritable() error {
	for _, directory := range []string{d.libraryDir(), d.recipesDir(), d.stateDir()} {
		file, err := os.CreateTemp(directory, ".ushelf-write-check-*")
		if err != nil {
			return fmt.Errorf("%s is not writable: %w", directory, err)
		}
		name := file.Name()
		if err := file.Close(); err != nil {
			return err
		}
		if err := os.Remove(name); err != nil {
			return err
		}
	}
	return nil
}

func (d DockerDeployment) CheckImageArchitecture(ctx context.Context) error {
	architecture, err := d.output(ctx, "image", "inspect", "--format", "{{.Architecture}}", d.Context.Image())
	if err != nil {
		return err
	}
	if strings.TrimSpace(architecture) != runtime.GOARCH {
		return fmt.Errorf("image architecture is %s, CLI architecture is %s", strings.TrimSpace(architecture), runtime.GOARCH)
	}
	return nil
}

func (d DockerDeployment) CheckManagedHealth(ctx context.Context) error {
	exists, err := d.managedContainerExists(ctx, containerName)
	if err != nil || !exists {
		return err
	}
	status, err := d.inspect(ctx, containerName, "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}")
	if err != nil {
		return err
	}
	if value := strings.TrimSpace(status); value != "healthy" && value != "running" {
		return fmt.Errorf("managed container is %s", value)
	}
	return nil
}

func (d DockerDeployment) step(format string, args ...any) { d.Actions.Step(format, args...) }
func (d DockerDeployment) done(format string, args ...any) { d.Actions.Done(format, args...) }

func (d DockerDeployment) user() string {
	if d.remote() {
		return imageUser
	}
	return currentUser()
}

func (d DockerDeployment) publishHost() string {
	if d.Context.Host() == "localhost" {
		return "127.0.0.1"
	}
	return d.Context.Host()
}

func (d DockerDeployment) libraryDir() string { return filepath.Join(d.Context.Home, "library") }
func (d DockerDeployment) itemsDir() string   { return filepath.Join(d.libraryDir(), "items") }
func (d DockerDeployment) historyDir() string { return filepath.Join(d.libraryDir(), "history") }
func (d DockerDeployment) recipesDir() string { return filepath.Join(d.Context.Home, "recipes") }
func (d DockerDeployment) stateDir() string   { return filepath.Join(d.Context.Home, "state") }
func (d DockerDeployment) assetsDir() string  { return filepath.Join(d.Context.Home, "assets") }
func (d DockerDeployment) secretsDir() string { return filepath.Join(d.Context.Home, "secrets") }

func currentUser() string {
	if runtime.GOOS == "windows" {
		return imageUser
	}
	return fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
}

func hashValues(values ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(values, "\x00")))
	return hex.EncodeToString(sum[:])
}

func atomicWrite(path string, contents []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}
