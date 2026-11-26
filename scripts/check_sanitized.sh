#!/usr/bin/env bash
# Fail if any tracked file matches a pattern from .github/sanitize-patterns.txt
# (generic secret/private-path shapes only). Run from the repo root.
# Security guarantees:
# - Never masks git grep errors (only exit code 1 means clean; >=2 fails closed).
# - Never echoes matched secret lines to stdout/stderr (reports file:line only).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
patterns=.github/sanitize-patterns.txt
if [ ! -f "$patterns" ]; then
  echo "sanitization guard: missing $patterns" >&2
  exit 2
fi

pat_tmp=$(mktemp)
err_tmp=$(mktemp)
trap 'rm -f "$pat_tmp" "$err_tmp"' EXIT

grep -vE '^[[:space:]]*(#|$)' "$patterns" > "$pat_tmp"

set +e
matches=$(git grep -nEI -f "$pat_tmp" -- . ":(exclude)$patterns" ":(exclude)scripts/check_sanitized.sh" 2>"$err_tmp")
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  echo "sanitization guard: forbidden pattern found (line contents redacted):" >&2
  printf '%s\n' "$matches" | awk -F: '{print "  " $1 ":" $2}' >&2
  exit 1
elif [ "$rc" -ne 1 ]; then
  echo "sanitization guard: git grep failed with exit code $rc:" >&2
  cat "$err_tmp" >&2
  exit "$rc"
fi

echo "sanitization guard: clean"
