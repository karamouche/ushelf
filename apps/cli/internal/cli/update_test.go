package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
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
