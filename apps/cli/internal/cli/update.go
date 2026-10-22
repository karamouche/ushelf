package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var releasesAPI = "https://api.github.com/repos/karamouche/ushelf/releases/latest"

type release struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

func (s *commandState) update(ctx context.Context, checkOnly bool) error {
	if !checkOnly {
		s.actions().Step("Checking for uShelf updates...")
	}
	latest, err := fetchRelease(ctx)
	if err != nil {
		return err
	}
	current := strings.TrimPrefix(s.build.Version, "v")
	targetVersion := strings.TrimPrefix(latest.TagName, "v")
	if targetVersion == current {
		if checkOnly {
			fmt.Fprintf(s.deps.Stdout, "uShelf %s is already current.\n", current)
		} else {
			s.actions().Done("uShelf %s is already current", current)
		}
		return nil
	}
	if olderRelease(targetVersion, current) {
		// A rolled-back or tampered "latest" release must not silently downgrade the CLI.
		return fmt.Errorf("the latest release %s is older than this CLI (%s); reinstall with USHELF_VERSION=%s to downgrade on purpose", targetVersion, current, targetVersion)
	}
	if checkOnly {
		fmt.Fprintf(s.deps.Stdout, "Update available: %s -> %s\n", current, targetVersion)
		return nil
	}
	archiveName := fmt.Sprintf("ushelf_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	archiveURL, checksumsURL := "", ""
	for _, asset := range latest.Assets {
		switch asset.Name {
		case archiveName:
			archiveURL = asset.BrowserDownloadURL
		case "SHA256SUMS":
			checksumsURL = asset.BrowserDownloadURL
		}
	}
	if archiveURL == "" || checksumsURL == "" {
		return fmt.Errorf("release %s does not contain %s and SHA256SUMS", latest.TagName, archiveName)
	}
	actions := s.actions()
	actions.Step("Downloading uShelf %s...", targetVersion)
	archive, err := download(ctx, archiveURL)
	if err != nil {
		return err
	}
	checksums, err := download(ctx, checksumsURL)
	if err != nil {
		return err
	}
	actions.Step("Verifying the release archive and its build provenance...")
	if err := verifyChecksum(archiveName, archive, string(checksums)); err != nil {
		return err
	}
	if err := s.verifyReleaseProvenance(ctx, archiveName, archive); err != nil {
		return err
	}
	binary, err := extractBinary(archive)
	if err != nil {
		return err
	}

	executable, err := executablePath()
	if err != nil {
		return err
	}
	actions.Step("Installing uShelf %s...", targetVersion)
	if err := atomicWrite(executable, binary, 0o755); err != nil {
		return fmt.Errorf("replace %s: %w", executable, err)
	}
	actions.Done("Updated the uShelf CLI to %s", targetVersion)
	return s.rollOutUpdate(ctx, executable, targetVersion)
}

// rollOutUpdate redeploys the current context with the new CLI when it runs the
// release-matched image, then refreshes skill links that point at managed assets.
func (s *commandState) rollOutUpdate(ctx context.Context, executable, version string) error {
	current, err := s.currentContext()
	if err != nil || !current.Managed() {
		return nil
	}
	if current.Spec.Image != "" {
		fmt.Fprintf(s.deps.Stdout, "Context %s pins image %s; update it with `ushelf config set image` and run `ushelf start`.\n", current.Name, current.Spec.Image)
		return nil
	}
	actions := s.actions()
	actions.Step("Rolling context %s out to uShelf %s...", current.Name, version)
	if err := s.deps.Runner.Run(ctx, nil, s.deps.Stdout, s.deps.Stderr, executable, restartArgs(s.store.Home, current.Name)...); err != nil {
		return fmt.Errorf("CLI updated, but redeploying context %s failed: %w", current.Name, err)
	}
	client, err := current.Client()
	if err != nil {
		return err
	}
	bundle, err := client.Skills(ctx)
	if err != nil {
		return fmt.Errorf("refresh agent skills: %w", err)
	}
	skillsRoot, err := installSkills(s.assetsDir(), bundle)
	if err != nil {
		return err
	}
	return refreshManagedSkillLinks(skillsRoot, s.assetsDir())
}

// olderRelease reports whether target is a lower release than current. Versions that are not
// plain MAJOR.MINOR.PATCH, such as development builds, never block an update.
func olderRelease(target, current string) bool {
	targetParts, okTarget := releaseParts(target)
	currentParts, okCurrent := releaseParts(current)
	if !okTarget || !okCurrent {
		return false
	}
	for i := range targetParts {
		if targetParts[i] != currentParts[i] {
			return targetParts[i] < currentParts[i]
		}
	}
	return false
}

func releaseParts(version string) ([3]int, bool) {
	var parts [3]int
	fields := strings.Split(version, ".")
	if len(fields) != 3 {
		return parts, false
	}
	for i, field := range fields {
		value, err := strconv.Atoi(field)
		if err != nil || value < 0 {
			return parts, false
		}
		parts[i] = value
	}
	return parts, true
}

func restartArgs(home, contextName string) []string {
	return []string{"--home", home, "--context", contextName, "start"}
}

func fetchRelease(ctx context.Context) (release, error) {
	raw, err := download(ctx, releasesAPI)
	if err != nil {
		return release{}, err
	}
	var result release
	if err := json.Unmarshal(raw, &result); err != nil {
		return release{}, fmt.Errorf("parse latest release: %w", err)
	}
	if result.TagName == "" {
		return release{}, fmt.Errorf("latest release has no tag")
	}
	return result, nil
}

func download(ctx context.Context, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "ushelf-cli")
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %s", url, response.Status)
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, 128<<20))
	if err != nil {
		return nil, err
	}
	return contents, nil
}

func verifyChecksum(name string, contents []byte, checksums string) error {
	sum := sha256.Sum256(contents)
	want := hex.EncodeToString(sum[:])
	for _, line := range strings.Split(checksums, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			if !strings.EqualFold(fields[0], want) {
				return fmt.Errorf("checksum verification failed for %s", name)
			}
			return nil
		}
	}
	return fmt.Errorf("checksum for %s was not found", name)
}

func extractBinary(archive []byte) ([]byte, error) {
	gzipReader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open release archive: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if filepath.Base(header.Name) == "ushelf" && header.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(tarReader, 64<<20))
		}
	}
	return nil, fmt.Errorf("release archive does not contain ushelf")
}

func refreshManagedSkillLinks(sourceRoot, managedAssetsRoot string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	for _, root := range []string{filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".claude", "skills")} {
		for _, name := range []string{"ushelf-ingest", "ushelf-library"} {
			destination := filepath.Join(root, name)
			current, err := os.Readlink(destination)
			if err != nil || !pathWithin(managedAssetsRoot, current) {
				continue
			}
			if err := replaceSymlink(filepath.Join(sourceRoot, name), destination); err != nil {
				return err
			}
		}
	}
	return nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
