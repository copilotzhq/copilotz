#!/bin/sh
# Installs the Copilotz computer program on macOS or Linux, and connects this machine to an app:
#
#   curl -fsSL https://app.example.com/computer/download/install.sh | sh -s -- https://app.example.com --code K7Q-4MZ
#
# (--folder <name>: the folder its spaces go in, under ~/Copilotz, as the app's command says.)
#
# It downloads this machine's binary from the app's /computer/download/ (or --from <base>, where
# the release is), checks its SHA-256 against the release's manifest, puts it in ~/.copilotz/bin
# (and that on your PATH), then runs `computer install <app> --code <code>`: connected, the
# computer runs in the background, and starts when you log in. `computer uninstall` stops that.
# Run it again to update.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

app="" code="" from="" folder=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code) [ $# -ge 2 ] || fail "--code needs a code"; code=$2; shift 2 ;;
    --from) [ $# -ge 2 ] || fail "--from needs a URL"; from=$2; shift 2 ;;
    --folder) [ $# -ge 2 ] || fail "--folder needs a name"; folder=$2; shift 2 ;;
    -*) fail "unknown option $1" ;;
    *) app=$1; shift ;;
  esac
done
[ -n "$app" ] && [ -n "$code" ] || fail "usage: install.sh <app-url> --code <CODE> [--from <base>] [--folder <name>]"
# The app's own release is on its origin.
base=${from:-$(printf '%s\n' "$app" | sed 's#^\([a-z]*://[^/]*\).*#\1#')/computer/download/}
case $base in */) ;; *) base=$base/ ;; esac

case $(uname -s) in
  Darwin) os=macos system=macOS ;;
  Linux) os=linux system=Linux ;;
  *) fail "this is for macOS and Linux; on Windows, use install.ps1" ;;
esac
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "no build for $(uname -m) yet" ;;
esac
# A shell under Rosetta says x64 on Apple silicon: the native one is better.
if [ "$os" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
file=copilotz-computer-$os-$arch

if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "found no sha256sum or shasum to check the download with"; fi

dir=$HOME/.copilotz/bin
bin=$dir/computer
mkdir -p "$dir"
work=$(mktemp -d "${TMPDIR:-/tmp}/copilotz-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

curl -fsSL "${base}manifest.json" -o "$work/manifest.json" ||
  fail "couldn't get ${base}manifest.json"
# The manifest, one object per line: this platform's binary, its version and SHA-256.
flat=$(tr -d ' \t\r\n' <"$work/manifest.json" | tr '}' '\n')
version=$(printf '%s\n' "$flat" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -n 1)
expected=$(printf '%s\n' "$flat" | grep "\"file\":\"$file\"" |
  sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' | head -n 1)
[ -n "$expected" ] || fail "the release at $base has no $file"

say "Copilotz computer $version for $system ($arch)"
if [ -f "$bin" ] && [ "$(sha "$bin")" = "$expected" ]; then
  say "  already installed: ~/.copilotz/bin/computer"
else
  say "  downloading ${file}..."
  curl -fSL --progress-bar "$base$file" -o "$work/$file" || fail "couldn't download $base$file"
  [ "$(sha "$work/$file")" = "$expected" ] ||
    fail "$file's SHA-256 isn't the release's: not installed"
  say "  checked: its SHA-256 is the release's"
  chmod 755 "$work/$file"
  # Beside it first, then in its place at once (a running one keeps running, as it was).
  mv -f "$work/$file" "$bin.next"
  mv -f "$bin.next" "$bin"
  say "  installed: ~/.copilotz/bin/computer"
fi

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    line="export PATH=\"\$HOME/.copilotz/bin:\$PATH\""
    case ${SHELL:-} in
      */zsh) rc=$HOME/.zshrc ;;
      */bash) if [ "$os" = macos ]; then rc=$HOME/.bash_profile; else rc=$HOME/.bashrc; fi ;;
      */fish) rc=$HOME/.config/fish/config.fish; line="fish_add_path \$HOME/.copilotz/bin" ;;
      *) rc=$HOME/.profile ;;
    esac
    if ! grep -qs '.copilotz/bin' "$rc"; then
      mkdir -p "$(dirname "$rc")"
      printf '\n# Copilotz computer\n%s\n' "$line" >>"$rc"
      say "  added ~/.copilotz/bin to your PATH in ${rc#"$HOME"/}: new terminals have \`computer\`"
    fi
    ;;
esac

say ""
if [ -n "$folder" ]; then exec "$bin" install "$app" --code "$code" --folder "$folder"; fi
exec "$bin" install "$app" --code "$code"
