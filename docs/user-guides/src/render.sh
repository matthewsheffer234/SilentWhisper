#!/usr/bin/env bash
# Regenerates the three Silent Whisper PDF guides from their HTML sources in
# this directory, using a headless Chromium/Chrome. No network access needed.
#
# Usage: docs/user-guides/src/render.sh [chrome-binary]
#
# If no binary is given, tries `chromium`, `chromium-browser`,
# `google-chrome` on PATH, then falls back to the Chromium build cached by
# this repo's own Playwright e2e setup (frontend/node_modules), since that's
# already present in most dev environments here without any extra install.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CHROME="${1:-}"
if [ -z "$CHROME" ]; then
  for c in chromium chromium-browser google-chrome; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  CANDIDATE=$(find "$HOME/.cache/ms-playwright" -maxdepth 2 -type d -name 'chromium-*' 2>/dev/null | sort -V | tail -1)
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE/chrome-linux64/chrome" ]; then
    CHROME="$CANDIDATE/chrome-linux64/chrome"
  fi
fi
if [ -z "$CHROME" ]; then
  echo "No Chromium/Chrome binary found. Pass one explicitly: render.sh /path/to/chrome" >&2
  exit 1
fi

echo "Using: $CHROME"

render() {
  local html="$1" pdf="$2"
  "$CHROME" --headless --no-sandbox --disable-gpu \
    --print-to-pdf="$pdf" --print-to-pdf-no-header \
    "$html" >/dev/null 2>&1
  echo "  -> $pdf"
}

render "$(pwd)/cheat-sheet.html" "../Silent-Whisper-Quick-Start-Cheat-Sheet.pdf"
render "$(pwd)/user-guide.html"  "../Silent-Whisper-User-Guide.pdf"
render "$(pwd)/admin-guide.html" "../Silent-Whisper-Administrator-Guide.pdf"

echo "Done."
