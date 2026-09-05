#!/bin/sh
# Run every headless check. Exits non-zero if any of them fail, so this is safe
# to hang a pre-push hook or a CI step off.
#
# The checks run under JavaScriptCore, which ships with macOS — that is the whole
# reason the game has no test dependencies to install. jsc lives inside the
# framework bundle rather than on PATH, hence the path below.
#
#   ./tools/check.sh          # run all eight
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
# make the slower solvers fail in confusing ways. jump second, because the
# route levels are authored against the numbers it prints -- if the gap between
# a full jump and a tapped one closes, every anti-air trap in levels.js is
# either unavoidable or inert, and the solver would only tell you afterwards
# and in a much more confusing way. viewport third: it is about what reaches
# the screen rather than what the physics does, and it is the only check that
# knows the camera exists -- a level the window never scrolls to the end of is
# not worth solving.
CHECKS=${*:-"harness jump viewport escalate solver finale dark crusher"}

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
