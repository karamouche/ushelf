package cli

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type archiveManifest struct {
	Format    int                    `json:"format"`
	Version   string                 `json:"version"`
	CreatedAt string                 `json:"createdAt"`
	Entries   []archiveManifestEntry `json:"entries"`
}

type archiveManifestEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type archiveSource struct {
	Name string
	Path string
	Info os.FileInfo
}

func (s *commandState) remoteRequest(ctx context.Context, method, endpointPath, contentType string, body io.Reader) (*http.Response, error) {
	credentials, err := loadRemoteCredentials(s.settings.Home)
	if err != nil {
		return nil, err
	}
	transport := &remoteTokenTransport{state: s, credentials: &credentials, base: http.DefaultTransport}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(credentials.ServerURL, "/")+endpointPath, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		request.Header.Set("content-type", contentType)
	}
	return (&http.Client{Transport: transport}).Do(request)
}

func (s *commandState) remoteRebuild(ctx context.Context) error {
	response, err := s.remoteRequest(ctx, http.MethodPost, "/api/remote/rebuild-index", "application/json", strings.NewReader("{}"))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return remoteHTTPError("rebuild index", response)
	}
	_, _ = io.Copy(s.deps.Stdout, response.Body)
	fmt.Fprintln(s.deps.Stdout)
	return nil
}

func (s *commandState) remoteImport(ctx context.Context, source string) error {
	raw, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"filename": filepath.Base(source), "markdown": string(raw)})
	response, err := s.remoteRequest(ctx, http.MethodPost, "/api/remote/import", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return remoteHTTPError("import Markdown", response)
	}
	_, _ = io.Copy(s.deps.Stdout, response.Body)
	fmt.Fprintln(s.deps.Stdout)
	return nil
}

func (s *commandState) remoteKindleUpload(ctx context.Context, source string) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	response, err := s.remoteRequest(ctx, http.MethodPut, "/api/remote/kindle", "application/json", file)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return remoteHTTPError("upload Kindle credential", response)
	}
	return nil
}

func (s *commandState) remoteKindleStatus(ctx context.Context) error {
	response, err := s.remoteRequest(ctx, http.MethodGet, "/api/remote/kindle", "", nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return remoteHTTPError("read Kindle status", response)
	}
	_, err = io.Copy(s.deps.Stdout, response.Body)
	fmt.Fprintln(s.deps.Stdout)
	return err
}

func (s *commandState) remoteKindleDisconnect(ctx context.Context) error {
	response, err := s.remoteRequest(ctx, http.MethodDelete, "/api/remote/kindle", "", nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return remoteHTTPError("disconnect Kindle", response)
	}
	fmt.Fprintln(s.deps.Stdout, "Remote Kindle credential removed.")
	return nil
}

func (s *commandState) exportArchive(ctx context.Context, destination string) error {
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	temporary := absolute + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	succeeded := false
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
		if !succeeded {
			_ = os.Remove(temporary)
		}
	}()
	if s.settings.ActiveTarget == "remote" {
		response, err := s.remoteRequest(ctx, http.MethodGet, "/api/remote/export", "", nil)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return remoteHTTPError("export library", response)
		}
		if _, err := io.Copy(file, response.Body); err != nil {
			return err
		}
	} else {
		if err := writeMigrationArchive(file, s.settings.Home, s.build.Version, false); err != nil {
			return err
		}
		closed = true
	}
	if !closed {
		if err := file.Close(); err != nil {
			return err
		}
		closed = true
	}
	if err := os.Rename(temporary, absolute); err != nil {
		return err
	}
	succeeded = true
	fmt.Fprintf(s.deps.Stdout, "Exported uShelf archive to %s\n", absolute)
	return nil
}

func (s *commandState) migrateRemote(ctx context.Context, includeKindle bool) error {
	if s.settings.RemoteURL == "" {
		return errors.New("connect a remote uShelf before migrating")
	}
	if s.settings.ActiveTarget != "local" {
		return errors.New("select the local target before migration; it remains selected if migration fails")
	}
	return s.docker().withServiceStopped(ctx, func() error {
		reader, writer := io.Pipe()
		archiveErr := make(chan error, 1)
		go func() { archiveErr <- writeMigrationArchive(writer, s.settings.Home, s.build.Version, includeKindle) }()
		response, err := s.remoteRequest(ctx, http.MethodPut, "/api/remote/migration", "application/gzip", reader)
		if err != nil {
			_ = reader.CloseWithError(err)
			<-archiveErr
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			_ = reader.CloseWithError(errors.New("remote migration rejected"))
			<-archiveErr
			return remoteHTTPError("migrate library", response)
		}
		if err := <-archiveErr; err != nil {
			return err
		}
		config, err := readFileConfig(s.settings.ConfigPath)
		if err != nil {
			return err
		}
		config.ActiveTarget = "remote"
		if err := writeFileConfig(s.settings.ConfigPath, config); err != nil {
			return err
		}
		fmt.Fprintln(s.deps.Stdout, "Migration verified by the remote server. The local library remains unchanged as a backup.")
		return nil
	})
}

func writeMigrationArchive(destination io.WriteCloser, root, version string, includeKindle bool) error {
	defer destination.Close()
	sources, manifest, err := collectArchiveSources(root, version, includeKindle)
	if err != nil {
		return err
	}
	gzipWriter := gzip.NewWriter(destination)
	tarWriter := tar.NewWriter(gzipWriter)
	manifestBytes, _ := json.MarshalIndent(manifest, "", "  ")
	if err := tarWriter.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0o600, Size: int64(len(manifestBytes)), ModTime: time.Now()}); err != nil {
		return err
	}
	if _, err := tarWriter.Write(manifestBytes); err != nil {
		return err
	}
	for _, source := range sources {
		if err := tarWriter.WriteHeader(&tar.Header{Name: source.Name, Mode: 0o600, Size: source.Info.Size(), ModTime: source.Info.ModTime()}); err != nil {
			return err
		}
		file, err := os.Open(source.Path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(tarWriter, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if err := tarWriter.Close(); err != nil {
		return err
	}
	return gzipWriter.Close()
}

func collectArchiveSources(root, version string, includeKindle bool) ([]archiveSource, archiveManifest, error) {
	var sources []archiveSource
	for _, directory := range []string{"library", "recipes"} {
		err := filepath.Walk(filepath.Join(root, directory), func(filename string, info os.FileInfo, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("migration refuses symbolic link %s", filename)
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			relative, err := filepath.Rel(root, filename)
			if err != nil {
				return err
			}
			sources = append(sources, archiveSource{Name: filepath.ToSlash(relative), Path: filename, Info: info})
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, archiveManifest{}, err
		}
	}
	if includeKindle {
		filename := filepath.Join(root, "secrets", "kindle.json")
		if info, err := os.Lstat(filename); err == nil {
			if !info.Mode().IsRegular() {
				return nil, archiveManifest{}, errors.New("Kindle credential must be a regular file")
			}
			sources = append(sources, archiveSource{Name: "secrets/kindle.json", Path: filename, Info: info})
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, archiveManifest{}, err
		}
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].Name < sources[j].Name })
	manifest := archiveManifest{Format: 1, Version: version, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	for _, source := range sources {
		file, err := os.Open(source.Path)
		if err != nil {
			return nil, archiveManifest{}, err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return nil, archiveManifest{}, copyErr
		}
		if closeErr != nil {
			return nil, archiveManifest{}, closeErr
		}
		manifest.Entries = append(manifest.Entries, archiveManifestEntry{Path: source.Name, Size: source.Info.Size(), SHA256: hex.EncodeToString(hash.Sum(nil))})
	}
	return sources, manifest, nil
}

func remoteHTTPError(operation string, response *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return fmt.Errorf("%s: HTTP %d: %s", operation, response.StatusCode, strings.TrimSpace(string(raw)))
}
