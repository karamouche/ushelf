package cli

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/karamouche/ushelf/apps/cli/internal/api"
)

// Deployment operates the server behind a managed context.
type Deployment interface {
	// Apply creates or reconciles the deployment and returns once the platform reports it healthy.
	Apply(ctx context.Context) error
	// Stop removes or scales down compute while keeping the library data.
	Stop(ctx context.Context) error
	// State reports the platform's view, such as running, stopped, or not deployed.
	State(ctx context.Context) (string, error)
	Logs(ctx context.Context, follow bool, tail int) error
	// Diagnose reports driver prerequisites to the doctor command.
	Diagnose(ctx context.Context, check func(name string, err error))
}

// Maintainer runs one-shot jobs against the library while the service is paused.
type Maintainer interface {
	RebuildIndex(ctx context.Context) error
	Import(ctx context.Context, path string) error
}

var (
	serverReadyTimeout      = 2 * time.Minute
	serverReadyPollInterval = 2 * time.Second
)

func (s *commandState) deploymentFor(c Context) (Deployment, error) {
	switch c.Spec.Driver {
	case DriverLocal, DriverSSH:
		return s.dockerDeployment(c), nil
	case DriverFly:
		return FlyDeployment{Context: c, Runner: s.deps.Runner, Stderr: s.deps.Stderr, Stdout: s.deps.Stdout, Actions: s.actions()}, nil
	default:
		return nil, fmt.Errorf("context %q points to a server deployed outside uShelf; manage it with the tools that deployed it", c.Name)
	}
}

func (s *commandState) dockerDeployment(c Context) DockerDeployment {
	return DockerDeployment{Context: c, Runner: s.deps.Runner, Stdout: s.deps.Stdout, Stderr: s.deps.Stderr, Actions: s.actions()}
}

// waitForServer polls until the server answers authenticated requests, which also
// covers proxies and certificates that become ready after the container.
func waitForServer(ctx context.Context, client *api.Client) (api.ServerInfo, error) {
	deadline := time.Now().Add(serverReadyTimeout)
	var lastErr error
	for {
		info, err := client.Server(ctx)
		if err == nil {
			return info, nil
		}
		if api.IsUnauthorized(err) {
			return api.ServerInfo{}, fmt.Errorf("the server at %s rejected this context's API token", client.BaseURL())
		}
		lastErr = err
		if time.Now().After(deadline) {
			return api.ServerInfo{}, fmt.Errorf("timed out waiting for %s: %w", client.BaseURL(), lastErr)
		}
		select {
		case <-ctx.Done():
			return api.ServerInfo{}, errors.Join(ctx.Err(), lastErr)
		case <-time.After(serverReadyPollInterval):
		}
	}
}
