#!/bin/sh
set -eu

test_root=$(mktemp -d "${TMPDIR:-/tmp}/ushelf-installer-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; esac
case "$(uname -m)" in x86_64|amd64) architecture=amd64 ;; arm64|aarch64) architecture=arm64 ;; esac

release_dir="${test_root}/releases/v9.9.9"
mkdir -p "$release_dir" "${test_root}/payload"
printf '#!/bin/sh\necho test-ushelf\n' > "${test_root}/payload/ushelf"
chmod +x "${test_root}/payload/ushelf"
archive="ushelf_${platform}_${architecture}.tar.gz"
tar -C "${test_root}/payload" -czf "${release_dir}/${archive}" ushelf
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$release_dir" && sha256sum "$archive" > SHA256SUMS)
else
  (cd "$release_dir" && shasum -a 256 "$archive" > SHA256SUMS)
fi

USHELF_VERSION=v9.9.9 \
USHELF_RELEASE_BASE_URL="file://${test_root}/releases" \
USHELF_INSTALL_DIR="${test_root}/bin" \
HOME="$test_root" \
PATH="/usr/bin:/bin" \
  sh ./install.sh >/dev/null

test "$("${test_root}/bin/ushelf")" = "test-ushelf"
echo "Installer smoke test passed."
