#!/usr/bin/env bash
# Install locked dependencies for local Pi extensions and packages.
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NPM=${NPM:-npm}
IF_MISSING=false

case "${1:-}" in
  "") ;;
  --if-missing) IF_MISSING=true ;;
  *)
    echo "Usage: ${0##*/} [--if-missing]" >&2
    exit 2
    ;;
esac

install() {
  local directory=$1
  shift
  if $IF_MISSING && [[ -d "$ROOT/$directory/node_modules" ]]; then
    return
  fi
  echo "Installing dependencies in $directory..."
  (cd "$ROOT/$directory" && "$NPM" ci "$@")
}

install extensions/vertex-claude
install packages/pi-sandbox
install packages/pi-cursor-acp --ignore-scripts
