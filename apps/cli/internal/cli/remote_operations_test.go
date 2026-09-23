package cli

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMigrationArchiveIsVersionedAndExcludesLocalState(t *testing.T) {
	root := t.TempDir()
	for name, contents := range map[string]string{
		"library/items/item.md":   "---\nid: test\n---\n",
		"recipes/default.md":      "# Recipe",
		"state/ushelf.db":         "disposable",
		"auth/auth.db":            "private",
		"credentials/remote.json": "token",
	} {
		filename := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(t.TempDir(), "export.tar.gz")
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeMigrationArchive(file, root, "1.2.3", false); err != nil {
		t.Fatal(err)
	}

	archive, err := os.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	gzipReader, err := gzip.NewReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(gzipReader)
	names := map[string]bool{}
	var manifest archiveManifest
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names[header.Name] = true
		if header.Name == "manifest.json" {
			if err := json.NewDecoder(reader).Decode(&manifest); err != nil {
				t.Fatal(err)
			}
		}
	}
	if manifest.Format != 1 || manifest.Version != "1.2.3" || len(manifest.Entries) != 2 {
		t.Fatalf("manifest = %#v", manifest)
	}
	for _, forbidden := range []string{"state/ushelf.db", "auth/auth.db", "credentials/remote.json"} {
		if names[forbidden] {
			t.Fatalf("archive contains %s", forbidden)
		}
	}
}

func TestMigrationArchiveRejectsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "library"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/tmp", filepath.Join(root, "library", "escape")); err != nil {
		t.Fatal(err)
	}
	destination, err := os.Create(filepath.Join(t.TempDir(), "archive.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeMigrationArchive(destination, root, "1.2.3", false); err == nil {
		t.Fatal("migration accepted a symlink")
	}
}
