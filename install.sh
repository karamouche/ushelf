#!/bin/sh
set -eu

repository="karamouche/ushelf"
install_dir="${USHELF_INSTALL_DIR:-${HOME}/.local/bin}"
release_base="${USHELF_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download}"

os_name=$(uname -s)
case "$os_name" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "Unsupported operating system: $os_name" >&2; exit 1 ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) architecture="amd64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) echo "Unsupported architecture: $machine" >&2; exit 1 ;;
esac

version="${USHELF_VERSION:-}"
if [ -z "$version" ]; then
  latest_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${repository}/releases/latest")
  version=${latest_url##*/}
fi
case "$version" in v*) ;; *) version="v${version}" ;; esac

archive="ushelf_${platform}_${architecture}.tar.gz"
base_url="${release_base}/${version}"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/ushelf-install.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM

curl -fsSL "${base_url}/${archive}" -o "${temporary_dir}/${archive}"
curl -fsSL "${base_url}/SHA256SUMS" -o "${temporary_dir}/SHA256SUMS"

expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1 }' "${temporary_dir}/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "Checksum for ${archive} was not found." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${temporary_dir}/${archive}" | awk '{print $1}')
else
  actual=$(shasum -a 256 "${temporary_dir}/${archive}" | awk '{print $1}')
fi
if [ "$actual" != "$expected" ]; then
  echo "Checksum verification failed for ${archive}." >&2
  exit 1
fi

tar -xzf "${temporary_dir}/${archive}" -C "$temporary_dir" ushelf
mkdir -p "$install_dir"
install -m 0755 "${temporary_dir}/ushelf" "${install_dir}/ushelf.tmp"
mv "${install_dir}/ushelf.tmp" "${install_dir}/ushelf"

echo "Installed uShelf ${version} to ${install_dir}/ushelf"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) echo "Add ${install_dir} to PATH, then run: ushelf doctor" ;;
esac
