#!/bin/sh
# Starts QA Studio on Linux or macOS. A computer without Node.js 22 or newer gets a private
# copy of the current Node.js 24 release in .runtime/node; scripts/prepare.mjs then installs
# the npm packages and Playwright's Chromium when they are missing.
# Run ./start-studio.sh --restart to restart a running Studio instead of only upgrading it.
set -eu
cd "$(dirname "$0")"

MINIMUM_MAJOR=22
RELEASE=latest-v24.x
EXIT_NEEDS_SIGN_IN=3

node_ok() {
  "$1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MINIMUM_MAJOR ? 0 : 1)" 2>/dev/null
}

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else echo "Install curl or wget, or Node.js $MINIMUM_MAJOR or newer, and run this script again." >&2; exit 1
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

download_node() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "Unsupported system $(uname -s). Install Node.js $MINIMUM_MAJOR or newer." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "Unsupported processor $(uname -m). Install Node.js $MINIMUM_MAJOR or newer." >&2; exit 1 ;;
  esac
  echo "Node.js $MINIMUM_MAJOR or newer is not installed. Downloading a private copy for QA Studio..."
  base="https://nodejs.org/dist/$RELEASE"
  mkdir -p .runtime
  fetch "$base/SHASUMS256.txt" .runtime/SHASUMS256.txt
  line=$(grep -E "  node-v[0-9.]+-$os-$arch\.tar\.gz$" .runtime/SHASUMS256.txt | head -n 1)
  [ -n "$line" ] || { echo "No Node.js download for $os $arch was found at $base." >&2; exit 1; }
  expected=${line%% *}
  archive=${line##* }
  fetch "$base/$archive" ".runtime/$archive"
  if [ "$(sha256 ".runtime/$archive")" != "$expected" ]; then
    rm -f ".runtime/$archive"
    echo "The downloaded Node.js file does not match its published checksum." >&2
    exit 1
  fi
  rm -rf .runtime/node
  tar -xzf ".runtime/$archive" -C .runtime
  mv ".runtime/${archive%.tar.gz}" .runtime/node
  rm -f ".runtime/$archive" .runtime/SHASUMS256.txt
}

if command -v node >/dev/null 2>&1 && node_ok node; then
  NODE=$(command -v node)
else
  [ -x .runtime/node/bin/node ] && node_ok .runtime/node/bin/node || download_node
  NODE="$PWD/.runtime/node/bin/node"
fi
PATH="$(dirname "$NODE"):$PATH"
export PATH

"$NODE" scripts/prepare.mjs

mode=--upgrade
[ "${1:-}" = "--restart" ] && mode=--restart

status=0
"$NODE" launch.mjs "$mode" --open || status=$?
if [ "$status" -eq "$EXIT_NEEDS_SIGN_IN" ] && [ -t 0 ]; then
  echo 'Sign in with your QA Studio administrator account to check activity and back up the workspace before restarting.'
  printf 'QA Studio administrator username (blank to cancel): '
  read -r STUDIO_USERNAME
  if [ -z "$STUDIO_USERNAME" ]; then
    echo 'Restart cancelled. The running Studio server was not stopped.'
    exit "$status"
  fi
  printf 'QA Studio administrator password: '
  trap 'stty echo' EXIT
  stty -echo
  read -r STUDIO_PASSWORD
  stty echo
  echo
  status=0
  STUDIO_USERNAME="$STUDIO_USERNAME" STUDIO_PASSWORD="$STUDIO_PASSWORD" "$NODE" launch.mjs "$mode" --open || status=$?
fi
exit "$status"
