package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// Release archives carry a SLSA build provenance attestation that the release workflow signs
// through Sigstore with its GitHub Actions identity. Only that workflow on main can obtain a
// certificate for this identity, so a verified attestation proves the archive came from it,
// unlike SHA256SUMS, which anyone able to replace release assets can replace too.
const (
	releaseSignerIssuer     = "https://token.actions.githubusercontent.com"
	releaseSigner           = "https://github.com/karamouche/ushelf/.github/workflows/release.yml@refs/heads/main"
	slsaProvenancePredicate = "https://slsa.dev/provenance/v1"
)

var attestationsAPI = "https://api.github.com/repos/karamouche/ushelf/attestations/sha256:"

// releaseTrustedRoot fetches Sigstore's public-good trusted root through TUF, starting from the
// root embedded in sigstore-go, and caches it under cacheDir.
var releaseTrustedRoot = func(cacheDir string) (root.TrustedMaterial, error) {
	return root.FetchTrustedRootWithOptions(tuf.DefaultOptions().WithCachePath(cacheDir))
}

func (s *commandState) verifyReleaseProvenance(ctx context.Context, archiveName string, archive []byte) error {
	digest := sha256.Sum256(archive)
	bundles, err := fetchAttestations(ctx, hex.EncodeToString(digest[:]))
	if err != nil {
		return fmt.Errorf("fetch the build provenance of %s: %w", archiveName, err)
	}
	trusted, err := releaseTrustedRoot(filepath.Join(s.store.Home, "sigstore"))
	if err != nil {
		return fmt.Errorf("fetch the Sigstore trusted root: %w", err)
	}
	if err := verifyAttestations(bundles, digest[:], releaseSigner, trusted); err != nil {
		return fmt.Errorf("build provenance verification failed for %s: %w", archiveName, err)
	}
	return nil
}

func fetchAttestations(ctx context.Context, digest string) ([]*bundle.Bundle, error) {
	raw, err := download(ctx, attestationsAPI+digest)
	if err != nil {
		return nil, err
	}
	return parseAttestations(raw)
}

func parseAttestations(raw []byte) ([]*bundle.Bundle, error) {
	var response struct {
		Attestations []struct {
			Bundle json.RawMessage `json:"bundle"`
		} `json:"attestations"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("parse attestations: %w", err)
	}
	bundles := make([]*bundle.Bundle, 0, len(response.Attestations))
	for _, attestation := range response.Attestations {
		var parsed bundle.Bundle
		if err := parsed.UnmarshalJSON(attestation.Bundle); err != nil {
			continue
		}
		bundles = append(bundles, &parsed)
	}
	if len(bundles) == 0 {
		return nil, fmt.Errorf("the release has no attestations")
	}
	return bundles, nil
}

// verifyAttestations accepts the archive when one bundle is a SLSA provenance statement for
// its digest, signed by the signer workflow and recorded in the transparency log.
func verifyAttestations(bundles []*bundle.Bundle, digest []byte, signer string, trusted root.TrustedMaterial) error {
	verifier, err := verify.NewVerifier(trusted,
		verify.WithSignedCertificateTimestamps(1),
		verify.WithTransparencyLog(1),
		verify.WithObserverTimestamps(1))
	if err != nil {
		return err
	}
	identity, err := verify.NewShortCertificateIdentity(releaseSignerIssuer, "", signer, "")
	if err != nil {
		return err
	}
	policy := verify.NewPolicy(verify.WithArtifactDigest("sha256", digest), verify.WithCertificateIdentity(identity))
	var lastErr error
	for _, candidate := range bundles {
		result, err := verifier.Verify(candidate, policy)
		if err != nil {
			lastErr = err
			continue
		}
		if result.Statement == nil || result.Statement.PredicateType != slsaProvenancePredicate {
			lastErr = fmt.Errorf("the attestation is not SLSA build provenance")
			continue
		}
		return nil
	}
	return lastErr
}
