#!/usr/bin/env bash
# Fail if any tracked or staged file matches a pattern from .github/sanitize-patterns.txt
# (generic secret/private-path shapes only). Run from inside the git repository.
# Security guarantees:
# - Scans BOTH tracked working-tree files and the staged git index (--cached).
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

if ! grep -vE '^[[:space:]]*(#|$)' "$patterns" > "$pat_tmp" || [ ! -s "$pat_tmp" ]; then
  echo "sanitization guard: $patterns contains no active patterns" >&2
  exit 2
fi

run_scan() {
  local label="$1"
  shift
  local matches=""
  local rc=0
  set +e
  matches=$(git grep "$@" -nEI -f "$pat_tmp" -- . ":(exclude)$patterns" ":(exclude)scripts/check_sanitized.sh" 2>"$err_tmp")
  rc=$?
  set -e

  if [ "$rc" -eq 0 ]; then
    echo "sanitization guard: forbidden pattern found in ${label} (line contents redacted):" >&2
    printf '%s\n' "$matches" | awk -F: '{print "  " $1 ":" $2}' >&2
    exit 1
  elif [ "$rc" -ne 1 ]; then
    echo "sanitization guard: git grep (${label}) failed with exit code $rc:" >&2
    cat "$err_tmp" >&2
    exit "$rc"
  fi
}

run_scan "working tree"
run_scan "staged index" --cached

echo "sanitization guard: clean"
