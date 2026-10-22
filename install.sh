#!/bin/sh
set -eu

repository="karamouche/ushelf"
release_base="${USHELF_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download}"
# Downloads use HTTPS only; an explicit release mirror may also be a local file:// directory.
curl_protocols="=https"
if [ -n "${USHELF_RELEASE_BASE_URL:-}" ]; then
  curl_protocols="=https,file"
fi
if [ -n "${USHELF_INSTALL_DIR:-}" ]; then
  install_dir="$USHELF_INSTALL_DIR"
  install_dir_is_default=false
else
  install_dir="${HOME}/.local/bin"
  install_dir_is_default=true
fi

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

path_contains_install_dir() {
  case ":${PATH}:" in
    *":${install_dir}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

configure_user_path() {
  path_config=""
  path_config_display=""
  reload_command=""
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  login_shell=${SHELL:-}

  case "${login_shell##*/}" in
    zsh)
      path_config="${HOME}/.zshrc"
      path_config_display="~/.zshrc"
      reload_command="source ~/.zshrc"
      ;;
    bash)
      if [ "$os_name" = "Darwin" ]; then
        path_config="${HOME}/.bash_profile"
        path_config_display="~/.bash_profile"
        reload_command="source ~/.bash_profile"
      else
        path_config="${HOME}/.bashrc"
        path_config_display="~/.bashrc"
        reload_command="source ~/.bashrc"
      fi
      ;;
    fish)
      path_config="${HOME}/.config/fish/config.fish"
      path_config_display="~/.config/fish/config.fish"
      reload_command="source ~/.config/fish/config.fish"
      path_line='fish_add_path "$HOME/.local/bin"'
      ;;
    *) return 1 ;;
  esac

  if [ -f "$path_config" ] && grep -v '^[[:space:]]*#' "$path_config" | grep -q '[.]local/bin'; then
    path_config_changed=false
    return 0
  fi

  mkdir -p "$(dirname "$path_config")"
  printf '\n# uShelf - add user-installed commands to PATH\n%s\n' "$path_line" >> "$path_config"
  path_config_changed=true
  return 0
}

version="${USHELF_VERSION:-}"
if [ -z "$version" ]; then
  latest_url=$(curl -fsSLI --proto "=https" --tlsv1.2 -o /dev/null -w '%{url_effective}' "https://github.com/${repository}/releases/latest")
  version=${latest_url##*/}
fi
case "$version" in v*) ;; *) version="v${version}" ;; esac

archive="ushelf_${platform}_${architecture}.tar.gz"
base_url="${release_base}/${version}"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/ushelf-install.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM

curl -fsSL --proto "$curl_protocols" --tlsv1.2 "${base_url}/${archive}" -o "${temporary_dir}/${archive}"
curl -fsSL --proto "$curl_protocols" --tlsv1.2 "${base_url}/SHA256SUMS" -o "${temporary_dir}/SHA256SUMS"

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

# The checksum file comes from the same release, so it only catches corruption. Build provenance
# proves the archive was built by this repository's release workflow.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if ! gh attestation verify "${temporary_dir}/${archive}" --repo "$repository" \
    --signer-workflow "${repository}/.github/workflows/release.yml" >/dev/null 2>&1; then
    echo "Build provenance verification failed for ${archive}." >&2
    exit 1
  fi
  echo "Verified the build provenance of ${archive}."
elif [ "${USHELF_REQUIRE_PROVENANCE:-0}" = "1" ]; then
  echo "USHELF_REQUIRE_PROVENANCE=1 needs the GitHub CLI (gh), signed in, to verify ${archive}." >&2
  exit 1
else
  echo "Skipped the build provenance check; install and sign in to the GitHub CLI (gh) to enable it."
fi

tar -xzf "${temporary_dir}/${archive}" -C "$temporary_dir" ushelf
mkdir -p "$install_dir"
install -m 0755 "${temporary_dir}/ushelf" "${install_dir}/ushelf.tmp"
mv "${install_dir}/ushelf.tmp" "${install_dir}/ushelf"

echo "Installed uShelf ${version} to ${install_dir}/ushelf"
if path_contains_install_dir; then
  echo "uShelf is already available on PATH."
elif [ "$install_dir_is_default" = true ] && [ "${USHELF_NO_MODIFY_PATH:-0}" != "1" ] && configure_user_path; then
  if [ "$path_config_changed" = true ]; then
    echo "Added ~/.local/bin to PATH in ${path_config_display}."
  else
    echo "~/.local/bin is already configured in ${path_config_display}."
  fi
  echo "Open a new terminal, or run: ${reload_command}"
else
  echo "Add ${install_dir} to PATH to run uShelf by command name."
fi
echo "Run now: ${install_dir}/ushelf start (local) or ${install_dir}/ushelf deploy --help"
