#!/usr/bin/env bash
# Verify that all npm package imports in scripts/*.js resolve to installed packages.
# Exits 0 if all imports are satisfied, 1 if any are missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

missing=0

for script in "$SCRIPT_DIR"/*.js; do
  [ -f "$script" ] || continue

  # Extract bare package imports (skip relative ./  ../ and node: builtins)
  # Also skip Node.js built-in modules (path, url, fs, etc.)
  NODE_BUILTINS="^(assert|buffer|child_process|cluster|console|constants|crypto|dgram|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|worker_threads|zlib|sqlite)$"
  packages=$(grep -oP '(?<=from ")[^"]+(?=")' "$script" 2>/dev/null \
    | grep -v '^\.' \
    | grep -v '^node:' \
    | sed 's|/.*||' \
    | grep -vE "$NODE_BUILTINS" \
    || true)

  for pkg in $packages; do
    if [ ! -d "$PROJECT_DIR/node_modules/$pkg" ]; then
      echo "  MISSING: '$pkg' imported by $(basename "$script") but not installed"
      missing=1
    fi
  done
done

if [ "$missing" -eq 0 ]; then
  echo "  All script imports OK."
fi

exit $missing
