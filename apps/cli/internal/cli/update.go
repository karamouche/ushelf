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
	actions.Step("Verifying the release archive...")
	if err := verifyChecksum(archiveName, archive, string(checksums)); err != nil {
		return err
	}
	binary, err := extractBinary(archive)
	if err != nil {
		return err
	}

	updatedSettings := s.settings
	updatedSettings.Version = targetVersion
	updatedSettings.Image = defaultImage(targetVersion)
	if s.settings.Image != defaultImage(current) || os.Getenv("USHELF_IMAGE") != "" || s.flags.Changed != nil && s.flags.Changed("image") {
		updatedSettings.Image = s.settings.Image
	}
	updatedDocker := Docker{
		Settings: updatedSettings,
		Runner:   s.deps.Runner,
		Stdin:    s.deps.Stdin,
		Stdout:   s.deps.Stdout,
		Stderr:   s.deps.Stderr,
		Actions:  actions,
	}
	actions.Step("Preparing uShelf %s runtime assets...", targetVersion)
	if err := updatedDocker.EnsureImage(ctx); err != nil {
		return err
	}
	skillsRoot, err := updatedDocker.ExtractSkills(ctx)
	if err != nil {
		return err
	}
	if err := refreshManagedSkillLinks(skillsRoot, s.docker().assetsDir()); err != nil {
		return err
	}

	executable, err := executablePath()
	if err != nil {
		return err
	}
	wasRunning, err := s.docker().IsRunning(ctx)
	if err != nil {
		return err
	}
	actions.Step("Installing uShelf %s...", targetVersion)
	if err := atomicWrite(executable, binary, 0o755); err != nil {
		return fmt.Errorf("replace %s: %w", executable, err)
	}
	if wasRunning {
		actions.Step("Restarting uShelf with the updated CLI...")
		if err := s.deps.Runner.Run(ctx, nil, s.deps.Stdout, s.deps.Stderr, executable, restartArgs(updatedSettings)...); err != nil {
			return fmt.Errorf("CLI updated, but restarting uShelf failed: %w", err)
		}
	}
	actions.Done("Updated uShelf to %s", targetVersion)
	return nil
}

func restartArgs(settings Settings) []string {
	return []string{
		"--home", settings.Home,
		"--host", settings.Host,
		"--port", strconv.Itoa(settings.Port),
		"--base-path", settings.BasePath,
		"--image", settings.Image,
		"start",
	}
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
