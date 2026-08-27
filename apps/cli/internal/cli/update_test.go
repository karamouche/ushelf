package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"slices"
	"testing"
)

func TestVerifyChecksum(t *testing.T) {
	contents := []byte("release")
	sum := sha256.Sum256(contents)
	checksums := fmt.Sprintf("%x  ushelf_darwin_arm64.tar.gz\n", sum)
	if err := verifyChecksum("ushelf_darwin_arm64.tar.gz", contents, checksums); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksum("ushelf_darwin_arm64.tar.gz", []byte("tampered"), checksums); err == nil {
		t.Fatal("expected checksum failure")
	}
}

func TestExtractBinary(t *testing.T) {
	var archive bytes.Buffer
	gzipWriter := gzip.NewWriter(&archive)
	tarWriter := tar.NewWriter(gzipWriter)
	payload := []byte("binary")
	if err := tarWriter.WriteHeader(&tar.Header{Name: "ushelf", Mode: 0o755, Size: int64(len(payload)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	actual, err := extractBinary(archive.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(payload) {
		t.Fatalf("payload = %q", actual)
	}
}

func TestRestartArgsPreserveEffectiveSettings(t *testing.T) {
	for _, settings := range []Settings{
		{Home: "/Users/test/.ushelf", Host: "127.0.0.1", Port: 43110, BasePath: "/", Image: "ghcr.io/karamouche/ushelf:1.2.3"},
		{Home: "/srv/ushelf", Host: "0.0.0.0", Port: 44000, BasePath: "/reader/", Image: "example/custom:test"},
	} {
		want := []string{
			"--home", settings.Home,
			"--host", settings.Host,
			"--port", fmt.Sprintf("%d", settings.Port),
			"--base-path", settings.BasePath,
			"--image", settings.Image,
			"start",
		}
		if actual := restartArgs(settings); !slices.Equal(actual, want) {
			t.Fatalf("restartArgs(%+v) = %#v, want %#v", settings, actual, want)
		}
	}
}
