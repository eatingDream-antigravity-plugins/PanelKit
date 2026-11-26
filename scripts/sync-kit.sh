#!/usr/bin/env bash
# Zero-external-dep standalone sync & drift gate for agy-mcp-kit (A+B Hybrid architecture).
#
# Usage:
#   ./scripts/sync-kit.sh --update-manifest
#   ./scripts/sync-kit.sh --check-manifest
#   ./scripts/sync-kit.sh [--files f1,f2,...] [--map src=dest ...] [--force] <target-repo-dir>
#   ./scripts/sync-kit.sh --check <target-repo-dir>
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$KIT_ROOT/kit-manifest.json"

usage() {
  cat >&2 <<'EOF'
Usage:
  sync-kit.sh --update-manifest
  sync-kit.sh --check-manifest
  sync-kit.sh [--files src1,src2,...] [--map src=dest ...] [--force] <target-repo-dir>
  sync-kit.sh --check <target-repo-dir>
EOF
  exit 2
}

MODE="sync"
FILES_CSV=""
MAPS=()
FORCE="0"
TARGET_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --update-manifest) MODE="update-manifest"; shift ;;
    --check-manifest)  MODE="check-manifest"; shift ;;
    --check)           MODE="check"; shift ;;
    --force)           FORCE="1"; shift ;;
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

export KIT_ROOT MANIFEST MODE FILES_CSV FORCE TARGET_DIR
MAP_JOINED=""
if [ ${#MAPS[@]} -gt 0 ]; then
  MAP_JOINED="$(printf '%s\n' "${MAPS[@]}")"
fi
export MAP_JOINED

python3 - <<'PY'
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

kit_root = Path(os.environ["KIT_ROOT"]).resolve()
manifest_path = Path(os.environ["MANIFEST"])
mode = os.environ["MODE"]
files_csv = os.environ.get("FILES_CSV", "").strip()
force = os.environ.get("FORCE", "0") == "1"
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
    ("LICENSE", "THIRD_PARTY_LICENSES/agy-mcp-kit-LICENSE"),
]

O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
SYNC_META_NAME = ".agy-kit-sync.json"

def fail(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"sync-kit: {msg}\n")
    sys.exit(code)

def sha256_file_nofollow(p: Path) -> str:
    flags = os.O_RDONLY | O_NOFOLLOW
    try:
        fd = os.open(str(p), flags)
    except OSError as exc:
        fail(f"refusing to read '{p}': {exc}")
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(f"expected regular file, refusing '{p}'")
        h = hashlib.sha256()
        with os.fdopen(fd, "rb") as f:
            fd = -1
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    finally:
        if fd >= 0:
            os.close(fd)

def read_text_nofollow(p: Path) -> str:
    flags = os.O_RDONLY | O_NOFOLLOW
    try:
        fd = os.open(str(p), flags)
    except OSError as exc:
        fail(f"refusing to read '{p}': {exc}")
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(f"expected regular file, refusing '{p}'")
        with os.fdopen(fd, "r", encoding="utf-8") as f:
            fd = -1
            return f.read()
    finally:
        if fd >= 0:
            os.close(fd)

def atomic_write_bytes(dest_path: Path, data: bytes, file_mode: int | None = None) -> None:
    parent = dest_path.parent
    fd, tmp_name = tempfile.mkstemp(prefix=".agy-kit-tmp-", dir=str(parent))
    try:
        with os.fdopen(fd, "wb") as f:
            fd = -1
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if file_mode is not None:
            os.chmod(tmp_name, stat.S_IMODE(file_mode))
        os.replace(tmp_name, str(dest_path))
    except Exception:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

def validate_dest_rel(target_dir: Path, dest_rel: str) -> Path:
    if not isinstance(dest_rel, str) or not dest_rel:
        fail(f"invalid destination path: {dest_rel!r}")
    if "\x00" in dest_rel or "\\" in dest_rel:
        fail(f"unsafe destination path '{dest_rel}'")
    if dest_rel.startswith("/") or (len(dest_rel) >= 2 and dest_rel[1] == ":"):
        fail(f"destination path must be relative to target root: '{dest_rel}'")
    parts = dest_rel.split("/")
    for part in parts:
        if part in ("", ".", ".."):
            fail(f"path traversal or empty segment rejected in destination: '{dest_rel}'")
    if parts[0].lower() == ".git" or dest_rel == SYNC_META_NAME:
        fail(f"reserved destination path rejected: '{dest_rel}'")

    # Reject any symlink at any existing path component under target_dir.
    cur = target_dir
    for part in parts:
        cur = cur / part
        if cur.is_symlink():
            fail(f"symlink rejected in destination path: '{dest_rel}'")

    # Final containment check using lexical normalization.
    norm_target = os.path.normpath(str(target_dir))
    norm_dest = os.path.normpath(str(cur))
    if os.path.commonpath([norm_target, norm_dest]) != norm_target or norm_dest == norm_target:
        fail(f"destination escapes target repository root: '{dest_rel}'")
    return cur

def validate_sync_file(sync_file: Path) -> None:
    if sync_file.is_symlink():
        fail(f"refusing symlinked sync metadata file: {sync_file}")

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
        if not src_path.is_file() or src_path.is_symlink():
            fail(f"missing or invalid canonical kit file: {src}")
        entries[src] = {
            "defaultDest": default_dest,
            "sha256": sha256_file_nofollow(src_path),
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
    atomic_write_bytes(manifest_path, (json.dumps(data, indent=2) + "\n").encode("utf-8"))
    print(f"sync-kit: updated {manifest_path.name} ({len(data['files'])} files, v{data['version']})")
    sys.exit(0)

if mode == "check-manifest":
    if not manifest_path.is_file():
        fail("kit-manifest.json is missing; run --update-manifest")
    expected = compute_manifest()
    actual = json.loads(read_text_nofollow(manifest_path))
    if actual != expected:
        fail("kit-manifest.json is out of date; run ./scripts/sync-kit.sh --update-manifest")
    print(f"sync-kit: kit-manifest.json verified clean ({len(expected['files'])} files)")
    sys.exit(0)

if not target_raw:
    fail("<target-repo-dir> is required", code=2)

target_raw_path = Path(target_raw)
if target_raw_path.is_symlink():
    fail(f"refusing symlinked target directory: {target_raw}")
target_dir = target_raw_path.resolve()
if not target_dir.is_dir():
    fail(f"target directory does not exist: {target_dir}")

manifest = compute_manifest()
sync_file = target_dir / SYNC_META_NAME
validate_sync_file(sync_file)

if mode == "check":
    if not sync_file.exists():
        fail(f"missing {sync_file}; run sync-kit.sh <target-repo-dir> first")
    sync_meta = json.loads(read_text_nofollow(sync_file))
    synced_files = sync_meta.get("files", {})
    if not isinstance(synced_files, dict) or not synced_files:
        fail(f"no synced files recorded in {sync_file}")
    drifted = []
    for dest_rel, info in sorted(synced_files.items()):
        dest_path = validate_dest_rel(target_dir, dest_rel)
        if not isinstance(info, dict):
            drifted.append(f"  {dest_rel}: malformed metadata entry")
            continue
        src_rel = info.get("source")
        recorded_sha = info.get("sha256")
        if src_rel not in manifest["files"]:
            drifted.append(f"  {dest_rel}: unknown kit source '{src_rel}'")
            continue
        canonical_sha = manifest["files"][src_rel]["sha256"]
        if not dest_path.exists():
            drifted.append(f"  {dest_rel}: missing file")
            continue
        actual_sha = sha256_file_nofollow(dest_path)
        if actual_sha != recorded_sha:
            drifted.append(f"  {dest_rel}: local modification (expected {str(recorded_sha)[:12]}, got {actual_sha[:12]})")
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
        fail(f"invalid --map '{item}', expected src=dest", code=2)
    s, d = item.split("=", 1)
    s = s.strip()
    d = d.strip()
    if s not in manifest["files"]:
        fail(f"unknown kit source in --map: '{s}'", code=2)
    validate_dest_rel(target_dir, d)
    custom_maps[s] = d

prev_files: dict[str, dict] = {}
if sync_file.exists():
    prev = json.loads(read_text_nofollow(sync_file))
    raw_prev = prev.get("files", {})
    if not isinstance(raw_prev, dict):
        fail(f"malformed files map in {sync_file}")
    for dest, info in raw_prev.items():
        validate_dest_rel(target_dir, dest)
        if not isinstance(info, dict) or "source" not in info:
            fail(f"malformed entry for '{dest}' in {sync_file}")
        prev_files[dest] = info

prev_dest_by_src = {info["source"]: dest for dest, info in prev_files.items() if isinstance(info.get("source"), str)}

# Determine selected (src, dest) pairs.
selected: list[tuple[str, str]] = []
if files_csv:
    seen_srcs = set()
    for raw in files_csv.split(","):
        src = raw.strip()
        if not src:
            continue
        if src not in manifest["files"]:
            fail(f"unknown kit file '{src}'")
        if src in seen_srcs:
            continue
        seen_srcs.add(src)
        dest = custom_maps.get(src, prev_dest_by_src.get(src, manifest["files"][src]["defaultDest"]))
        selected.append((src, dest))
    # Always include MIT LICENSE notice alongside synced kit files.
    if "LICENSE" not in seen_srcs:
        lic_dest = custom_maps.get("LICENSE", prev_dest_by_src.get("LICENSE", manifest["files"]["LICENSE"]["defaultDest"]))
        selected.append(("LICENSE", lic_dest))
elif prev_files and not custom_maps:
    seen_srcs = set()
    for dest, info in sorted(prev_files.items()):
        src = info["source"]
        if src in manifest["files"]:
            selected.append((src, dest))
            seen_srcs.add(src)
    if "LICENSE" not in seen_srcs:
        selected.append(("LICENSE", manifest["files"]["LICENSE"]["defaultDest"]))
else:
    for src, meta in manifest["files"].items():
        selected.append((src, custom_maps.get(src, prev_dest_by_src.get(src, meta["defaultDest"]))))

# Pre-flight validation: reject duplicate destinations, unsafe paths, and unforced local modifications.
dest_seen: dict[str, str] = {}
conflicts: list[str] = []
validated_plan: list[tuple[str, str, Path, Path]] = []

for src, dest in selected:
    dest_path = validate_dest_rel(target_dir, dest)
    if dest in dest_seen:
        fail(f"duplicate destination path '{dest}' for '{dest_seen[dest]}' and '{src}'")
    dest_seen[dest] = src
    src_path = kit_root / src

    if dest_path.exists():
        actual_sha = sha256_file_nofollow(dest_path)
        prev_sha = prev_files.get(dest, {}).get("sha256")
        canonical_sha = manifest["files"][src]["sha256"]
        if not force and actual_sha != canonical_sha and actual_sha != prev_sha:
            conflicts.append(
                f"  {dest}: local modifications present (pass --force to overwrite)"
            )
    validated_plan.append((src, dest, src_path, dest_path))

if conflicts:
    sys.stderr.write("sync-kit: refusing to overwrite locally modified file(s):\n" + "\n".join(conflicts) + "\n")
    sys.exit(1)

# Merge with previously tracked files so selective --files syncs never silently untrack other synced files.
synced_record: dict[str, dict] = dict(prev_files)
for src, dest, src_path, dest_path in validated_plan:
    # Ensure no directory component became a symlink before mkdir.
    validate_dest_rel(target_dir, dest)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    validate_dest_rel(target_dir, dest)
    raw_bytes = src_path.read_bytes()
    src_mode = src_path.stat().st_mode
    atomic_write_bytes(dest_path, raw_bytes, file_mode=src_mode)
    # Remove any old destination entry if this source was remapped to a new destination.
    for old_dest, old_info in list(synced_record.items()):
        if old_dest != dest and old_info.get("source") == src:
            del synced_record[old_dest]
    synced_record[dest] = {
        "source": src,
        "sha256": manifest["files"][src]["sha256"],
    }

sync_payload = {
    "schemaVersion": 1,
    "kit": "agy-mcp-kit",
    "kitVersion": manifest["version"],
    "kitCommit": read_kit_commit(),
    "files": dict(sorted(synced_record.items())),
}
validate_sync_file(sync_file)
atomic_write_bytes(sync_file, (json.dumps(sync_payload, indent=2) + "\n").encode("utf-8"))
print(f"sync-kit: synced {len(validated_plan)} file(s) into {target_dir} ({len(synced_record)} tracked in {SYNC_META_NAME})")
PY
