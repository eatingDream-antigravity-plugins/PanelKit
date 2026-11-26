#!/usr/bin/env bash
# Zero-external-dep standalone sync & drift gate for agy-mcp-kit (A+B Hybrid architecture).
#
# Usage:
#   ./scripts/sync-kit.sh --update-manifest
#   ./scripts/sync-kit.sh --check-manifest
#   ./scripts/sync-kit.sh [--files f1,f2,...] [--map src=dest ...] <target-repo-dir>
#   ./scripts/sync-kit.sh --check <target-repo-dir>
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$KIT_ROOT/kit-manifest.json"

usage() {
  cat >&2 <<'EOF'
Usage:
  sync-kit.sh --update-manifest
  sync-kit.sh --check-manifest
  sync-kit.sh [--files src1,src2,...] [--map src=dest ...] <target-repo-dir>
  sync-kit.sh --check <target-repo-dir>
EOF
  exit 2
}

MODE="sync"
FILES_CSV=""
MAPS=()
TARGET_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --update-manifest) MODE="update-manifest"; shift ;;
    --check-manifest)  MODE="check-manifest"; shift ;;
    --check)           MODE="check"; shift ;;
    --files)
      [ $# -ge 2 ] || usage
      FILES_CSV="$2"; shift 2 ;;
    --map)
      [ $# -ge 2 ] || usage
      MAPS+=("$2"); shift 2 ;;
    -h|--help) usage ;;
    -*) echo "sync-kit: unknown option: $1" >&2; usage ;;
    *)
      [ -z "$TARGET_DIR" ] || usage
      TARGET_DIR="$1"; shift ;;
  esac
done

export KIT_ROOT MANIFEST MODE FILES_CSV TARGET_DIR
MAP_JOINED=""
if [ ${#MAPS[@]} -gt 0 ]; then
  MAP_JOINED="$(printf '%s\n' "${MAPS[@]}")"
fi
export MAP_JOINED

python3 - <<'PY'
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

kit_root = Path(os.environ["KIT_ROOT"]).resolve()
manifest_path = Path(os.environ["MANIFEST"])
mode = os.environ["MODE"]
files_csv = os.environ.get("FILES_CSV", "").strip()
target_raw = os.environ.get("TARGET_DIR", "").strip()
map_lines = [l for l in os.environ.get("MAP_JOINED", "").splitlines() if l.strip()]

CANONICAL_FILES = [
    ("src/mcp_protocol.rs", "src/kit/mcp_protocol.rs"),
    ("src/swr_cache.rs", "src/kit/swr_cache.rs"),
    ("src/html_boot.rs", "src/kit/html_boot.rs"),
    ("src/test_guard.rs", "src/kit/test_guard.rs"),
    ("panel/tokens.css", "panel/kit/tokens.css"),
    ("panel/bridge.js", "panel/kit/bridge.js"),
    ("panel/guard.mjs", "panel/kit/guard.mjs"),
    ("scripts/check_sanitized.sh", "scripts/check_sanitized.sh"),
    (".github/sanitize-patterns.txt", ".github/sanitize-patterns.txt"),
]

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def read_kit_version() -> str:
    cargo = (kit_root / "Cargo.toml").read_text(encoding="utf-8")
    for line in cargo.splitlines():
        s = line.strip()
        if s.startswith("version") and "=" in s:
            return s.split("=", 1)[1].strip().strip('"').strip("'")
    return "0.0.0"

def read_kit_commit() -> str:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(kit_root), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or "uncommitted"
    except Exception:
        return "uncommitted"

def compute_manifest() -> dict:
    entries = {}
    for src, default_dest in CANONICAL_FILES:
        src_path = kit_root / src
        if not src_path.is_file():
            sys.stderr.write(f"sync-kit: missing canonical kit file: {src}\n")
            sys.exit(1)
        entries[src] = {
            "defaultDest": default_dest,
            "sha256": sha256_file(src_path),
            "bytes": src_path.stat().st_size,
        }
    return {
        "schemaVersion": 1,
        "kit": "agy-mcp-kit",
        "version": read_kit_version(),
        "files": entries,
    }

if mode == "update-manifest":
    data = compute_manifest()
    manifest_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"sync-kit: updated {manifest_path.name} ({len(data['files'])} files, v{data['version']})")
    sys.exit(0)

if mode == "check-manifest":
    if not manifest_path.is_file():
        sys.stderr.write("sync-kit: kit-manifest.json is missing; run --update-manifest\n")
        sys.exit(1)
    expected = compute_manifest()
    actual = json.loads(manifest_path.read_text(encoding="utf-8"))
    if actual != expected:
        sys.stderr.write("sync-kit: kit-manifest.json is out of date; run ./scripts/sync-kit.sh --update-manifest\n")
        sys.exit(1)
    print(f"sync-kit: kit-manifest.json verified clean ({len(expected['files'])} files)")
    sys.exit(0)

if not target_raw:
    sys.stderr.write("sync-kit: <target-repo-dir> is required\n")
    sys.exit(2)

target_dir = Path(target_raw).resolve()
if not target_dir.is_dir():
    sys.stderr.write(f"sync-kit: target directory does not exist: {target_dir}\n")
    sys.exit(1)

manifest = compute_manifest()
sync_file = target_dir / ".agy-kit-sync.json"

if mode == "check":
    if not sync_file.is_file():
        sys.stderr.write(f"sync-kit: missing {sync_file}; run sync-kit.sh <target-repo-dir> first\n")
        sys.exit(1)
    sync_meta = json.loads(sync_file.read_text(encoding="utf-8"))
    synced_files = sync_meta.get("files", {})
    if not synced_files:
        sys.stderr.write(f"sync-kit: no synced files recorded in {sync_file}\n")
        sys.exit(1)
    drifted = []
    for dest_rel, info in sorted(synced_files.items()):
        src_rel = info.get("source")
        recorded_sha = info.get("sha256")
        if src_rel not in manifest["files"]:
            drifted.append(f"  {dest_rel}: unknown kit source '{src_rel}'")
            continue
        canonical_sha = manifest["files"][src_rel]["sha256"]
        dest_path = target_dir / dest_rel
        if not dest_path.is_file():
            drifted.append(f"  {dest_rel}: missing file")
            continue
        actual_sha = sha256_file(dest_path)
        if actual_sha != recorded_sha:
            drifted.append(f"  {dest_rel}: local modification (expected {recorded_sha[:12]}, got {actual_sha[:12]})")
        elif actual_sha != canonical_sha:
            drifted.append(f"  {dest_rel}: behind agy-mcp-kit {src_rel} (kit {canonical_sha[:12]}, target {actual_sha[:12]})")
    if drifted:
        sys.stderr.write("sync-kit: drift detected:\n" + "\n".join(drifted) + "\n")
        sys.exit(1)
    print(f"sync-kit: zero drift verified across {len(synced_files)} synced file(s) in {target_dir.name}")
    sys.exit(0)

# mode == "sync"
custom_maps = {}
for item in map_lines:
    if "=" not in item:
        sys.stderr.write(f"sync-kit: invalid --map '{item}', expected src=dest\n")
        sys.exit(2)
    s, d = item.split("=", 1)
    custom_maps[s.strip()] = d.strip()

# Preserve existing mapping when re-syncing without explicit --files
selected = []
if files_csv:
    for raw in files_csv.split(","):
        src = raw.strip()
        if not src:
            continue
        if src not in manifest["files"]:
            sys.stderr.write(f"sync-kit: unknown kit file '{src}'\n")
            sys.exit(1)
        dest = custom_maps.get(src, manifest["files"][src]["defaultDest"])
        selected.append((src, dest))
elif sync_file.is_file() and not custom_maps:
    prev = json.loads(sync_file.read_text(encoding="utf-8"))
    for dest, info in sorted(prev.get("files", {}).items()):
        src = info["source"]
        if src in manifest["files"]:
            selected.append((src, dest))
else:
    for src, meta in manifest["files"].items():
        selected.append((src, custom_maps.get(src, meta["defaultDest"])))

synced_record = {}
for src, dest in selected:
    src_path = kit_root / src
    dest_path = target_dir / dest
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_path, dest_path)
    synced_record[dest] = {
        "source": src,
        "sha256": manifest["files"][src]["sha256"],
    }

sync_payload = {
    "schemaVersion": 1,
    "kit": "agy-mcp-kit",
    "kitVersion": manifest["version"],
    "kitCommit": read_kit_commit(),
    "files": synced_record,
}
sync_file.write_text(json.dumps(sync_payload, indent=2) + "\n", encoding="utf-8")
print(f"sync-kit: synced {len(synced_record)} file(s) into {target_dir} (recorded in .agy-kit-sync.json)")
PY
