package cli

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestVerifyChecksumsSignature(t *testing.T) {
	public, private := testReleaseKey(t)
	useReleaseSigningKeys(t, public)
	checksums := []byte("f177aa1e  ushelf_darwin_arm64.tar.gz\n")
	signature := ed25519.Sign(private, checksums)

	if err := verifyChecksumsSignature(checksums, signature); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksumsSignature([]byte("0000aa1e  ushelf_darwin_arm64.tar.gz\n"), signature); err == nil {
		t.Fatal("expected replaced checksums to be rejected")
	}
	if err := verifyChecksumsSignature(checksums, signature[:10]); err == nil {
		t.Fatal("expected a truncated signature to be rejected")
	}
}

func TestVerifyChecksumsSignatureRejectsOtherKeys(t *testing.T) {
	public, _ := testReleaseKey(t)
	_, attacker := testReleaseKey(t)
	useReleaseSigningKeys(t, public)
	checksums := []byte("f177aa1e  ushelf_darwin_arm64.tar.gz\n")

	if err := verifyChecksumsSignature(checksums, ed25519.Sign(attacker, checksums)); err == nil {
		t.Fatal("expected a signature from another key to be rejected")
	}
}

func TestVerifyChecksumsSignatureAcceptsAnyListedKeyDuringRotation(t *testing.T) {
	previous, _ := testReleaseKey(t)
	next, private := testReleaseKey(t)
	useReleaseSigningKeys(t, previous, next)
	checksums := []byte("f177aa1e  ushelf_darwin_arm64.tar.gz\n")

	if err := verifyChecksumsSignature(checksums, ed25519.Sign(private, checksums)); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseSigningKeysAreValid(t *testing.T) {
	for _, encoded := range releaseSigningKeys {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(key) != ed25519.PublicKeySize {
			t.Fatalf("release signing key %q is not a base64 Ed25519 public key", encoded)
		}
	}
}

func testReleaseKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private
}

func useReleaseSigningKeys(t *testing.T, keys ...ed25519.PublicKey) {
	t.Helper()
	previous := releaseSigningKeys
	releaseSigningKeys = nil
	for _, key := range keys {
		releaseSigningKeys = append(releaseSigningKeys, base64.StdEncoding.EncodeToString(key))
	}
	t.Cleanup(func() { releaseSigningKeys = previous })
}
