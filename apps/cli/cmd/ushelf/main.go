package main

import (
	"context"
	"fmt"
	"os"

	"github.com/karamouche/ushelf/apps/cli/internal/cli"
)

var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	command := cli.NewRootCommand(cli.Dependencies{
		Runner: cli.OSRunner{},
		Stdin:  os.Stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	}, cli.BuildInfo{Version: version, Commit: commit, BuildDate: buildDate})
	if err := command.ExecuteContext(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
