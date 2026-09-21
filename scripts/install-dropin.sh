#!/usr/bin/env bash
# Install the decisionkit pi extension (S0 + guardrail/routing/critic drop-in)
# into a target repo as .pi/extensions/decisionkit, self-contained (real copies,
# no symlinks) via npm pack tarballs of packages/core + packages/pi-ext.
#
# Usage:
#   scripts/install-dropin.sh <target-repo-dir>
#
# Pack note: the shipped pi-calibrated default inside decisionkit-core loads
# automatically — there is no per-repo pack and nothing else to copy.
#
# NOTE: tarballs snapshot the code at install time. After editing packages/core
# or packages/pi-ext, re-run this script (and `npm run build` in packages/core
# first — it copies question-packs into dist/).

set -euo pipefail

WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
DROPIN="$WORKSPACE/packages/pi-ext/m3/dropin"
TARGET="${1:?usage: scripts/install-dropin.sh <target-repo-dir>}"

TARGET="$(cd "$TARGET" && pwd)"
DST="$TARGET/.pi/extensions/decisionkit"

# Fresh builds → fresh tarballs (question-packs must exist in core dist/).
(cd "$WORKSPACE/packages/core" && npm run build >/dev/null)

TGZ_DIR="$(mktemp -d)"
trap 'rm -rf "$TGZ_DIR"' EXIT
CORE_TGZ="$TGZ_DIR/$(npm pack "$WORKSPACE/packages/core" --pack-destination "$TGZ_DIR" | tail -1)"
EXT_TGZ="$TGZ_DIR/$(npm pack "$WORKSPACE/packages/pi-ext" --pack-destination "$TGZ_DIR" | tail -1)"

if [ -d "$DST" ]; then
  echo "removing existing $DST"
  rm -rf "$DST"
fi

mkdir -p "$TARGET/.pi/extensions"
cp -R "$DROPIN" "$DST"

# Rewrite deps to the packed tarballs (npm extracts tarballs as real copies).
sed -i '' \
  -e "s|file:DECISIONKIT_CORE_PATH|file:$CORE_TGZ|" \
  -e "s|file:DECISIONKIT_PI_EXT_PATH|file:$EXT_TGZ|" \
  "$DST/package.json"

(cd "$DST" && npm install --omit=dev --no-package-lock)

# Sanity: the installed deps must be real directories, not symlinks.
for dep in decisionkit-core decisionkit-pi-ext; do
  if [ -L "$DST/node_modules/$dep" ]; then
    echo "ERROR: $dep was installed as a symlink" >&2
    exit 1
  fi
done

if [ -f "$WORKSPACE/.env" ] && [ ! -f "$TARGET/.env" ]; then
  cp "$WORKSPACE/.env" "$TARGET/.env"
  echo "shipped workspace .env into $TARGET (delete when done)"
fi

echo
echo "installed self-contained decisionkit drop-in at $DST"
echo "run: cd \"$TARGET\" && pi"
echo "env: DECISIONKIT_S0=0 disables S0 · DECISIONKIT_ANSWER_ONLY=1 enables answer-only (M5)"
