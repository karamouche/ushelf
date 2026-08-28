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

release_base="file://${test_root}/releases"

run_default_install() {
  case_root=$1
  login_shell=$2
  output_file=$3
  no_modify_path=${4:-0}
  mkdir -p "$case_root"
  HOME="$case_root" \
  SHELL="$login_shell" \
  PATH="/usr/bin:/bin" \
  USHELF_VERSION=v9.9.9 \
  USHELF_RELEASE_BASE_URL="$release_base" \
  USHELF_NO_MODIFY_PATH="$no_modify_path" \
    sh ./install.sh > "$output_file"
  test "$("${case_root}/.local/bin/ushelf")" = "test-ushelf"
}

zsh_root="${test_root}/zsh"
run_default_install "$zsh_root" /bin/zsh "${test_root}/zsh-first.out"
grep -qF 'export PATH="$HOME/.local/bin:$PATH"' "${zsh_root}/.zshrc"
grep -qF 'source ~/.zshrc' "${test_root}/zsh-first.out"
grep -qF "Run now: ${zsh_root}/.local/bin/ushelf doctor" "${test_root}/zsh-first.out"
run_default_install "$zsh_root" /bin/zsh "${test_root}/zsh-second.out"
test "$(grep -cF 'export PATH="$HOME/.local/bin:$PATH"' "${zsh_root}/.zshrc")" -eq 1

bash_root="${test_root}/bash"
run_default_install "$bash_root" /bin/bash "${test_root}/bash.out"
if [ "$(uname -s)" = "Darwin" ]; then
  bash_config="${bash_root}/.bash_profile"
else
  bash_config="${bash_root}/.bashrc"
fi
grep -qF 'export PATH="$HOME/.local/bin:$PATH"' "$bash_config"

fish_root="${test_root}/fish"
run_default_install "$fish_root" /usr/bin/fish "${test_root}/fish.out"
grep -qF 'fish_add_path "$HOME/.local/bin"' "${fish_root}/.config/fish/config.fish"
grep -qF 'source ~/.config/fish/config.fish' "${test_root}/fish.out"

configured_root="${test_root}/configured"
mkdir -p "$configured_root"
HOME="$configured_root" \
SHELL=/bin/zsh \
PATH="${configured_root}/.local/bin:/usr/bin:/bin" \
USHELF_VERSION=v9.9.9 \
USHELF_RELEASE_BASE_URL="$release_base" \
  sh ./install.sh > "${test_root}/configured.out"
test ! -e "${configured_root}/.zshrc"
grep -qF 'already available on PATH' "${test_root}/configured.out"

opt_out_root="${test_root}/opt-out"
run_default_install "$opt_out_root" /bin/zsh "${test_root}/opt-out.out" 1
test ! -e "${opt_out_root}/.zshrc"
grep -qF "Add ${opt_out_root}/.local/bin to PATH" "${test_root}/opt-out.out"

custom_root="${test_root}/custom"
mkdir -p "$custom_root"
HOME="$custom_root" \
SHELL=/bin/zsh \
PATH="/usr/bin:/bin" \
USHELF_VERSION=v9.9.9 \
USHELF_RELEASE_BASE_URL="$release_base" \
USHELF_INSTALL_DIR="${custom_root}/bin" \
  sh ./install.sh > "${test_root}/custom.out"
test "$("${custom_root}/bin/ushelf")" = "test-ushelf"
test ! -e "${custom_root}/.zshrc"
grep -qF "Add ${custom_root}/bin to PATH" "${test_root}/custom.out"

unknown_root="${test_root}/unknown"
run_default_install "$unknown_root" /bin/example-shell "${test_root}/unknown.out"
test ! -e "${unknown_root}/.example-shellrc"
grep -qF "Add ${unknown_root}/.local/bin to PATH" "${test_root}/unknown.out"

echo "Installer smoke test passed."
