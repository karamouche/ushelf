package cli

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
)

// The release workflow signs SHA256SUMS with an Ed25519 key kept as a GitHub Actions secret.
// SHA256SUMS ships beside the archives, so anyone able to replace release assets could replace
// it too; its signature can only come from the key, so a verified signature proves the
// checksums were published by the release workflow. Listing several keys allows a rotation:
// add the new key, release with it, then drop the old one.
var releaseSigningKeys = []string{
	"Rv3s+KET5s93QFiBm4dM9uka5cgJAUCrwb5KnhQuXbI=",
}

func verifyChecksumsSignature(checksums, signature []byte) error {
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("SHA256SUMS.sig is not an Ed25519 signature")
	}
	for _, encoded := range releaseSigningKeys {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(key) != ed25519.PublicKeySize {
			return fmt.Errorf("invalid built-in release signing key")
		}
		if ed25519.Verify(ed25519.PublicKey(key), checksums, signature) {
			return nil
		}
	}
	return fmt.Errorf("SHA256SUMS is not signed by the uShelf release key")
}
