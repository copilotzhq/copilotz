#!/bin/bash
# A pool VM's startup script (Debian 12; setup-gcp.sh puts it in the pools' templates). It makes
# the VM a computer-to-be: the tools agents use (git, Node.js 24, Python, build tools, Chrome), the
# computer program from the app's release (its SHA-256 checked against the release's manifest),
# and `copilotz-pool.service`, which runs `computer pool --app <app-url> --root /mnt/computer`:
# connected to the app as a free VM, it waits to serve a computer, whose disk it mounts there.
#
# It reads the VM's metadata: `app-url` (the app it connects to) and `computer-release` (where the
# release is: its base URL, or its manifest.json's). With `copilotz-image=TRUE` (a VM an image is
# made from: setup-gcp.sh's IMAGE), it shuts down once everything's installed, with no service: pool
# VMs made from that image then boot in seconds, as each checks only the program's release. It runs at every boot, and skips what's done
# already. What it says goes to the serial console (and Cloud Logging) through Google's startup
# script runner; the service's own output goes there too.
set -euo pipefail

say() { echo "copilotz-pool: $*"; }
fail() {
  echo "copilotz-pool: $*" >&2
  exit 1
}
metadata() {
  curl -fsS --retry 5 --retry-connrefused -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

STATE=/var/lib/copilotz
BIN=/usr/local/bin/computer
ROOT=/mnt/computer
UNIT=/etc/systemd/system/copilotz-pool.service
mkdir -p "$STATE" "$ROOT"
export DEBIAN_FRONTEND=noninteractive
# apt waits for its lock: Debian's own daily upgrades may hold it as the VM boots.
echo 'DPkg::Lock::Timeout "600";' >/etc/apt/apt.conf.d/90copilotz-lock

app=$(metadata app-url) || fail "no app-url in the VM's metadata"
release=$(metadata computer-release) || fail "no computer-release in the VM's metadata"
release=${release%manifest.json}
case $release in */) ;; *) release=$release/ ;; esac

case $(uname -m) in
  x86_64) arch=x64 node_arch=x64 deb_arch=amd64 ;;
  aarch64) arch=arm64 node_arch=arm64 deb_arch=arm64 ;;
  *) fail "no computer program for $(uname -m)" ;;
esac

# The tools, once (a marker says they're there).
if [ ! -f "$STATE/packages.done" ]; then
  say "installing packages"
  apt-get update -q
  apt-get install -yq --no-install-recommends \
    git curl ca-certificates unzip xz-utils build-essential \
    python3 python3-pip python3-venv
  touch "$STATE/packages.done"
fi

# Node.js 24, from nodejs.org (its SHA-256 checked against the release's SHASUMS256.txt).
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  say "installing Node.js 24"
  work=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
  line=$(grep " node-v24\.[0-9.]*-linux-$node_arch\.tar\.xz\$" "$work/SHASUMS256.txt" | head -n 1)
  [ -n "$line" ] || fail "no Node.js 24 for linux-$node_arch"
  file=${line##* }
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" -o "$work/$file"
  (cd "$work" && printf '%s\n' "$line" | sha256sum -c --quiet -) ||
    fail "$file's SHA-256 isn't nodejs.org's"
  tar -xJf "$work/$file" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm -rf "$work"
fi

# A browser for the computer's agents: Google Chrome (it has no Linux build for arm64: Chromium).
if ! command -v google-chrome-stable >/dev/null && ! command -v chromium >/dev/null; then
  if [ "$deb_arch" = amd64 ]; then
    say "installing Google Chrome"
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      -o /tmp/google-chrome.deb
    apt-get install -yq /tmp/google-chrome.deb
    rm -f /tmp/google-chrome.deb
  else
    say "installing Chromium"
    apt-get install -yq chromium
  fi
fi

# The computer program, as install.sh gets it: this machine's binary, checked against the manifest.
file=copilotz-computer-linux-$arch
curl -fsSL --retry 5 "${release}manifest.json" -o "$STATE/manifest.json" ||
  fail "couldn't get ${release}manifest.json"
expected=$(python3 - "$STATE/manifest.json" "$file" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
print(next((b["sha256"] for b in manifest["binaries"] if b["file"] == sys.argv[2]), ""))
PY
)
[ -n "$expected" ] || fail "the release at $release has no $file"
updated=""
if [ -f "$BIN" ] && [ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$expected" ]; then
  say "the computer program is there already"
else
  updated=1
  say "downloading $file"
  curl -fsSL --retry 5 "$release$file" -o "$BIN.next" || fail "couldn't download $release$file"
  [ "$(sha256sum "$BIN.next" | cut -d' ' -f1)" = "$expected" ] ||
    { rm -f "$BIN.next"; fail "$file's SHA-256 isn't the release's"; }
  chmod 755 "$BIN.next"
  mv -f "$BIN.next" "$BIN"
fi

# An image's VM: done. Each VM made from the image gets a machine id of its own; this one stops,
# its disk ready to make the image from.
if [ "$(metadata copilotz-image 2>/dev/null || true)" = TRUE ]; then
  truncate -s 0 /etc/machine-id
  rm -f /var/lib/dbus/machine-id
  say "image ready: stopping"
  sync
  shutdown -h now
  exit 0
fi

# The service: as root (it mounts the computer's disk), again whenever it stops.
unit="[Unit]
Description=Copilotz computer pool: serves a computer from the app
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
Environment=HOME=/root
ExecStart=$BIN pool --app $app --root $ROOT
Restart=always
RestartSec=2
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target"
if [ -z "$updated" ] && [ -f "$UNIT" ] && [ "$(cat "$UNIT")" = "$unit" ] &&
  systemctl is-active --quiet copilotz-pool; then
  say "copilotz-pool.service runs already"
else
  printf '%s\n' "$unit" >"$UNIT"
  systemctl daemon-reload
  systemctl enable copilotz-pool.service
  systemctl restart copilotz-pool.service
  say "copilotz-pool.service started: $BIN pool --app $app"
fi
