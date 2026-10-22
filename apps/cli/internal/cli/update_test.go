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

func TestRestartArgsTargetTheUpdatedContext(t *testing.T) {
	want := []string{"--home", "/srv/ushelf", "--context", "vps", "start"}
	if actual := restartArgs("/srv/ushelf", "vps"); !slices.Equal(actual, want) {
		t.Fatalf("restartArgs = %#v, want %#v", actual, want)
	}
}

func TestOlderReleaseBlocksOnlyRealDowngrades(t *testing.T) {
	for _, tc := range []struct {
		target, current string
		older           bool
	}{
		{"0.1.1", "0.1.2", true},
		{"0.9.9", "1.0.0", true},
		{"1.0.0", "0.9.9", false},
		{"0.1.10", "0.1.9", false},
		{"0.1.2", "dev", false},
		{"0.1.2", "0.1.3-rc.1", false},
	} {
		if got := olderRelease(tc.target, tc.current); got != tc.older {
			t.Errorf("olderRelease(%q, %q) = %v, want %v", tc.target, tc.current, got, tc.older)
		}
	}
}
