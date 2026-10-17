package cli

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/karamouche/ushelf/apps/cli/internal/api"
	"github.com/karamouche/ushelf/apps/cli/internal/kindle"
	"github.com/spf13/cobra"
)

func (s *commandState) kindleCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "kindle",
		Short: "Connect and manage Amazon Send to Kindle for the current context",
		Long: "Connect and manage the unofficial Amazon Send to Kindle integration.\n\n" +
			"Amazon sign-in happens in your browser on this machine. The resulting device\n" +
			"credential is uploaded to the current context's server, which uses it to deliver\n" +
			"items; it is not kept on this machine.",
	}
	command.AddCommand(s.kindleSetupCommand(), s.kindleStatusCommand(), s.kindleDisconnectCommand())
	return command
}

func (s *commandState) kindleClient() (*api.Client, error) {
	current, err := s.currentContext()
	if err != nil {
		return nil, err
	}
	return current.Client()
}

func (s *commandState) kindleSetupCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Connect the current context to an Amazon Kindle account",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := s.kindleClient()
			if err != nil {
				return err
			}
			status, err := client.KindleStatus(command.Context())
			if err != nil {
				return fmt.Errorf("check Kindle status: %w", err)
			}
			if status.Configured {
				return errors.New("Kindle is already configured; run `ushelf kindle disconnect` first")
			}

			reader := bufio.NewReader(s.deps.Stdin)
			fmt.Fprintln(s.deps.Stdout, "WARNING: This integration is unofficial and uses Amazon's undocumented Send to Kindle protocol.")
			fmt.Fprintln(s.deps.Stdout, "Amazon may change or disable it without notice. Use it only with an account you own.")
			fmt.Fprint(s.deps.Stdout, "Continue? [y/N] ")
			if !confirmed(reader) {
				return errors.New("Kindle setup cancelled")
			}

			verifier, err := s.deps.Kindle.NewVerifier()
			if err != nil {
				return fmt.Errorf("create Amazon verifier: %w", err)
			}
			signInURL := s.deps.Kindle.SignInURL(verifier)
			fmt.Fprintf(s.deps.Stdout, "\nOpen this Amazon sign-in URL:\n\n%s\n\n", signInURL)
			_ = s.deps.Runner.Run(command.Context(), nil, io.Discard, io.Discard, browserOpener(), signInURL)
			fmt.Fprint(s.deps.Stdout, "After Amazon finishes redirecting, paste the full URL from the address bar:\n> ")
			redirect, err := reader.ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			redirect = strings.TrimSpace(redirect)
			if err := validateKindleRedirect(redirect); err != nil {
				return err
			}
			code, err := s.deps.Kindle.AuthorizationCode(redirect)
			if err != nil {
				return errors.New("Amazon sign-in did not provide an authorization code")
			}
			ctx, cancel := context.WithTimeout(command.Context(), kindle.OperationTimeout)
			defer cancel()
			actions := s.actions()
			actions.Step("Connecting to Amazon Send to Kindle...")
			registered, err := s.deps.Kindle.Register(ctx, code, verifier)
			if err != nil {
				return fmt.Errorf("register Kindle connection: %w", err)
			}
			var credential bytes.Buffer
			if err := registered.Marshal(&credential); err != nil {
				return errors.Join(fmt.Errorf("encode Kindle credential: %w", err), registered.Deregister(ctx))
			}
			actions.Step("Uploading the Kindle credential to uShelf...")
			if _, err := client.KindleConnect(ctx, credential.Bytes()); err != nil {
				// Do not leave an orphaned registration on the Amazon account.
				return errors.Join(fmt.Errorf("upload Kindle credential: %w", err), registered.Deregister(ctx))
			}
			actions.Done("Kindle connected for %q (%s)", registered.AccountName(), registered.HomeRegion())
			return nil
		},
	}
}

func (s *commandState) kindleStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Check the Kindle connection and list devices",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := s.kindleClient()
			if err != nil {
				return err
			}
			ctx, cancel := context.WithTimeout(command.Context(), kindle.OperationTimeout)
			defer cancel()
			status, err := client.KindleStatus(ctx)
			if err != nil {
				return fmt.Errorf("check Kindle status: %w", err)
			}
			if !status.Configured {
				return errors.New("Kindle is not configured; run `ushelf kindle setup`")
			}
			if status.Error != nil {
				return fmt.Errorf("Kindle is configured but unavailable: %s", status.Error.Message)
			}
			devices, err := client.KindleDevices(ctx)
			if err != nil {
				return fmt.Errorf("contact Amazon Send to Kindle: %w", err)
			}
			fmt.Fprintf(s.deps.Stdout, "Account: %s\nRegion: %s\nDevices: %d\n", status.AccountName, status.HomeRegion, len(devices))
			for _, device := range devices {
				fmt.Fprintf(s.deps.Stdout, "  %s · %s\n", device.Name, maskedSerial(device.Serial))
			}
			return nil
		},
	}
}

func (s *commandState) kindleDisconnectCommand() *cobra.Command {
	var yes, skipDeregister bool
	command := &cobra.Command{
		Use:   "disconnect",
		Short: "Deregister uShelf from Amazon and remove the server's Kindle credential",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := s.kindleClient()
			if err != nil {
				return err
			}
			if skipDeregister && !yes {
				return errors.New("--skip-deregister requires --yes because the Amazon registration will remain active")
			}
			if !yes {
				fmt.Fprint(s.deps.Stdout, "Deregister uShelf from this Amazon account? [y/N] ")
				if !confirmed(bufio.NewReader(s.deps.Stdin)) {
					return errors.New("Kindle disconnect cancelled")
				}
			}
			ctx, cancel := context.WithTimeout(command.Context(), kindle.OperationTimeout)
			defer cancel()
			if skipDeregister {
				s.actions().Step("Removing the Kindle credential from uShelf...")
			} else {
				s.actions().Step("Deregistering uShelf from Amazon...")
			}
			if err := client.KindleDisconnect(ctx, !skipDeregister); err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "not_configured" {
					return errors.New("Kindle is not configured")
				}
				if !skipDeregister {
					return fmt.Errorf("disconnect Kindle: %w; use --skip-deregister --yes only if the credential cannot be recovered", err)
				}
				return fmt.Errorf("disconnect Kindle: %w", err)
			}
			s.actions().Done("Kindle disconnected")
			return nil
		},
	}
	command.Flags().BoolVar(&yes, "yes", false, "confirm without prompting")
	command.Flags().BoolVar(&skipDeregister, "skip-deregister", false, "remove the credential without deregistering it from Amazon")
	return command
}

func (s *commandState) reportKindleDoctor(ctx context.Context, client *api.Client) {
	ctx, cancel := context.WithTimeout(ctx, kindle.OperationTimeout)
	defer cancel()
	status, err := client.KindleStatus(ctx)
	switch {
	case err != nil:
		fmt.Fprintf(s.deps.Stdout, "INFO Kindle status unavailable: %v\n", err)
	case !status.Configured:
		fmt.Fprintln(s.deps.Stdout, "INFO Kindle not configured")
	case status.Error != nil:
		fmt.Fprintf(s.deps.Stdout, "INFO Kindle configured, but unavailable: %s\n", status.Error.Message)
	default:
		fmt.Fprintf(s.deps.Stdout, "INFO Kindle connected for %s\n", status.AccountName)
	}
}

func confirmed(reader *bufio.Reader) bool {
	answer, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	normalized := strings.ToLower(strings.TrimSpace(answer))
	return normalized == "y" || normalized == "yes"
}

func validateKindleRedirect(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "www.amazon.com" || parsed.Path != "/gp/sendtokindle" {
		return errors.New("paste the final https://www.amazon.com/gp/sendtokindle URL")
	}
	return nil
}

func maskedSerial(value string) string {
	if len(value) <= 4 {
		return value
	}
	return "••••" + value[len(value)-4:]
}
