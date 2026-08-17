#!/bin/sh
# Run every headless check. Exits non-zero if any of them fail, so this is safe
# to hang a pre-push hook or a CI step off.
#
# The checks run under JavaScriptCore, which ships with macOS — that is the whole
# reason the game has no test dependencies to install. jsc lives inside the
# framework bundle rather than on PATH, hence the path below.
#
#   ./tools/check.sh          # run all four
#   ./tools/check.sh solver   # run just one
set -eu

JSC=${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc}

if [ ! -x "$JSC" ]; then
  echo "jsc not found at $JSC" >&2
  echo "Set JSC=/path/to/jsc if your macOS keeps it elsewhere." >&2
  exit 127
fi

# The checks load ../js/*.js relative to their own directory, so run from there.
cd "$(dirname "$0")"

# harness first: it is the cheapest and catches load-time breakage that would
# make the slower solvers fail in confusing ways.
CHECKS=${*:-"harness solver finale dark crusher"}

failed=""
for name in $CHECKS; do
  printf '\n=== %s ===\n' "$name"
  # Not `set -e`-fatal on purpose: run every check, then report all failures at
  # the end. One broken level shouldn't hide a second broken one.
  if ! "$JSC" "$name.js"; then
    failed="$failed $name"
  fi
done

printf '\n'
if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
echo "All checks passed."
