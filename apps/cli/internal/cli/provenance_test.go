package cli

import (
	"context"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
)

// The v0.1.2 release attestation covers every archive, including this darwin_arm64 one.
const attestedArchiveDigest = "f177aa1e11dc79f59e50391725fd0756063ecc1fc45928e31a85ff6a74aa2ca4"

func TestVerifyAttestationsAcceptsReleaseProvenance(t *testing.T) {
	bundles, trusted := releaseAttestationFixture(t)
	if err := verifyAttestations(bundles, mustDecodeHex(t, attestedArchiveDigest), releaseSigner, trusted); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyAttestationsRejectsAnotherArchive(t *testing.T) {
	bundles, trusted := releaseAttestationFixture(t)
	digest := mustDecodeHex(t, attestedArchiveDigest)
	digest[0] ^= 0xff
	if err := verifyAttestations(bundles, digest, releaseSigner, trusted); err == nil {
		t.Fatal("expected an archive outside the attestation to be rejected")
	}
}

func TestVerifyAttestationsRejectsAnotherSigner(t *testing.T) {
	bundles, trusted := releaseAttestationFixture(t)
	signer := strings.Replace(releaseSigner, "@refs/heads/main", "@refs/heads/feature", 1)
	if err := verifyAttestations(bundles, mustDecodeHex(t, attestedArchiveDigest), signer, trusted); err == nil {
		t.Fatal("expected an attestation from another workflow ref to be rejected")
	}
}

func TestFetchAttestationsRequestsTheArchiveDigest(t *testing.T) {
	fixture, err := os.ReadFile("testdata/attestations-v0.1.2.json")
	if err != nil {
		t.Fatal(err)
	}
	var requested string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.Path
		_, _ = w.Write(fixture)
	}))
	defer server.Close()
	previous := attestationsAPI
	attestationsAPI = server.URL + "/attestations/sha256:"
	defer func() { attestationsAPI = previous }()

	bundles, err := fetchAttestations(context.Background(), attestedArchiveDigest)
	if err != nil {
		t.Fatal(err)
	}
	if requested != "/attestations/sha256:"+attestedArchiveDigest || len(bundles) != 1 {
		t.Fatalf("requested %q and parsed %d bundles", requested, len(bundles))
	}
}

func TestParseAttestationsRequiresABundle(t *testing.T) {
	if _, err := parseAttestations([]byte(`{"attestations":[]}`)); err == nil {
		t.Fatal("expected a release without attestations to be rejected")
	}
}

func releaseAttestationFixture(t *testing.T) ([]*bundle.Bundle, root.TrustedMaterial) {
	t.Helper()
	raw, err := os.ReadFile("testdata/attestations-v0.1.2.json")
	if err != nil {
		t.Fatal(err)
	}
	bundles, err := parseAttestations(raw)
	if err != nil {
		t.Fatal(err)
	}
	rootJSON, err := os.ReadFile("testdata/sigstore-trusted-root.json")
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := root.NewTrustedRootFromJSON(rootJSON)
	if err != nil {
		t.Fatal(err)
	}
	return bundles, trusted
}

func mustDecodeHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
