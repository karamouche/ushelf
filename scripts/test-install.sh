#!/bin/sh
set -eu

test_root=$(mktemp -d "${TMPDIR:-/tmp}/ushelf-installer-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
# Keep a real, signed-in GitHub CLI from verifying the fake test archive.
export GH_CONFIG_DIR="${test_root}/gh-config"
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN

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
grep -qF "Run now: ${zsh_root}/.local/bin/ushelf start (local) or ${zsh_root}/.local/bin/ushelf deploy --help" "${test_root}/zsh-first.out"
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

# A signed-in GitHub CLI makes provenance verification mandatory for the install.
fake_gh_dir="${test_root}/fake-gh"
mkdir -p "$fake_gh_dir"
cat > "${fake_gh_dir}/gh" <<'GH'
#!/bin/sh
case "$1" in
  auth) exit 0 ;;
  attestation) exit "${FAKE_GH_VERIFY_STATUS:-0}" ;;
esac
exit 2
GH
chmod +x "${fake_gh_dir}/gh"

run_provenance_install() {
  case_root=$1
  verify_status=$2
  mkdir -p "$case_root"
  HOME="$case_root" \
  SHELL=/bin/zsh \
  PATH="${fake_gh_dir}:/usr/bin:/bin" \
  FAKE_GH_VERIFY_STATUS="$verify_status" \
  USHELF_VERSION=v9.9.9 \
  USHELF_RELEASE_BASE_URL="$release_base" \
  USHELF_NO_MODIFY_PATH=1 \
    sh ./install.sh > "${case_root}.out" 2>&1
}

run_provenance_install "${test_root}/provenance-ok" 0
grep -qF "Verified the build provenance" "${test_root}/provenance-ok.out"
test "$("${test_root}/provenance-ok/.local/bin/ushelf")" = "test-ushelf"

if run_provenance_install "${test_root}/provenance-bad" 1; then
  echo "Installer accepted an archive that failed provenance verification." >&2
  exit 1
fi
grep -qF "Build provenance verification failed" "${test_root}/provenance-bad.out"
test ! -e "${test_root}/provenance-bad/.local/bin/ushelf"

grep -qF "Skipped the build provenance check" "${test_root}/custom.out"
required_root="${test_root}/required"
mkdir -p "$required_root"
if HOME="$required_root" SHELL=/bin/zsh PATH="/usr/bin:/bin" USHELF_VERSION=v9.9.9 \
  USHELF_RELEASE_BASE_URL="$release_base" USHELF_REQUIRE_PROVENANCE=1 \
  sh ./install.sh > "${test_root}/required.out" 2>&1; then
  echo "Installer ignored USHELF_REQUIRE_PROVENANCE without gh." >&2
  exit 1
fi
test ! -e "${required_root}/.local/bin/ushelf"

echo "Installer smoke test passed."
