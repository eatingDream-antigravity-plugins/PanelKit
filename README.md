<div align="center">

# PanelKit (agy-mcp-kit)

**Canonical Rust MCP runtime primitives, SEP-1865 Editorial-Warm panel kit, and zero-drift vendor sync for Antigravity plugins.**

[Homepage](https://eatingdream.dev) · English | [简体中文](README.zh-CN.md) · [AI Guide](docs/ai-guide.md) · [`llms.txt`](llms.txt)

[![CI](https://github.com/eatingDream-antigravity-plugins/PanelKit/actions/workflows/ci.yml/badge.svg)](https://github.com/eatingDream-antigravity-plugins/PanelKit/actions/workflows/ci.yml)
![Built with Rust](https://img.shields.io/badge/built%20with-Rust-1A1916?logo=rust&logoColor=white)
![SEP-1865](https://img.shields.io/badge/MCP%20Apps-SEP--1865-D97757)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

## What It Is

**PanelKit** (`agy-mcp-kit`) is the single source of truth behind the [eatingDream Antigravity Plugin Suite](https://eatingdream.dev) — [ContextRadar](https://github.com/eatingDream-antigravity-plugins/ContextRadar) (`context-radar-mcp`), [ClamGuard](https://github.com/eatingDream-antigravity-plugins/ClamGuard) (`mac-clamshell-mcp`), [RemoteCast](https://github.com/eatingDream-antigravity-plugins/RemoteCast) (`chrome-stream-mcp`), and [ColabDeck](https://github.com/eatingDream-antigravity-plugins/ColabDeck) (`colab-mcp`). It combines:

- **B — Canonical Library & Test Suite**: Battle-tested, zero-bloat Rust modules (`serde`/`serde_json` only) and Editorial-Warm panel primitives verified by `cargo test --locked` and `node --test`.
- **A — Zero-External-Dep Standalone Sync**: `scripts/sync-kit.sh` + SHA256 `kit-manifest.json` vendor tiny canonical files directly into each plugin repo with `--check` drift verification—keeping every plugin's offline `cargo build --release --locked` fast and standalone.

It is **not** a monolithic framework, heavy async runtime, or mandatory private git dependency.

## Included Modules

| Layer | File | Responsibility |
| :--- | :--- | :--- |
| **MCP Protocol** | [`src/mcp_protocol.rs`](src/mcp_protocol.rs) | Version negotiation (`2025-11-25`..`2024-11-05`), strict SEP-1865 `mimeTypes` array check, shared `tools/list` + `tools/call` visibility enforcement, JSON-RPC 2.0 single & batch dispatch |
| **SWR Cache** | [`src/swr_cache.rs`](src/swr_cache.rs) | Thread-safe `SwrCache<T>`: `<1 ms` non-blocking warm reads, single-flight background refresh, bounded cold wait, monotonic `rev` + `is_unchanged(since_rev)` |
| **HTML Boot** | [`src/html_boot.rs`](src/html_boot.rs) | Split-point `HtmlLoader` with `(mtime, len)` cache, pre-located boot slot, and `</script>` / `<!--` safe JSON escaping |
| **Test Guard** | [`src/test_guard.rs`](src/test_guard.rs) | Compile-time `#[cfg(test)]` refusal (`ensure_not_in_test` & `guard_host_effect!`) blocking live OS/hardware side effects in tests |
| **Panel Tokens** | [`panel/tokens.css`](panel/tokens.css) | Exact 16 Editorial-Warm two-letter tokens (dark `#141311`, light `#FAF8F4` with `--ok: #2F7D53`), reduced-motion, zero `prefers-color-scheme` |
| **Panel Bridge** | [`panel/bridge.js`](panel/bridge.js) | Strict `ev.source === parent` SEP-1865 PostMessage client, coalesced/retried `ui/initialize` (`2026-01-26`), `serverTools` detection, live theme sync, net RTT measurement |
| **Panel QA Gate** | [`panel/guard.mjs`](panel/guard.mjs) | Executable invariant checker (`assertPanelInvariants`) enforcing UTF-8 byte budget, single `<script>`, `default-src 'none'`, zero `innerHTML`/`opacity:0`/`--buncss-*`, and all 16 tokens |

## Quick Start

Verify the kit locally:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
node --test panel/test/kit.test.mjs
./scripts/sync-kit.sh --check-manifest
./scripts/check_sanitized.sh
```

Sync selected or all kit files into a sibling plugin repo and verify zero drift:

```sh
./scripts/sync-kit.sh ../mac-clamshell-mcp
./scripts/sync-kit.sh --check ../mac-clamshell-mcp
```

Validate any compiled self-contained `panel.html` from the CLI:

```sh
node panel/guard.mjs ../mac-clamshell-mcp/panel/dist/panel.html --max-bytes 43500
```

## Sync Workflow (A+B Hybrid)

Downstream plugins choose either full sync or a selective subset (`--files` / `--map`):

```sh
./scripts/sync-kit.sh \
  --files src/mcp_protocol.rs,src/swr_cache.rs,panel/bridge.js,panel/guard.mjs \
  ../colab-mcp
```

Every sync writes `.agy-kit-sync.json` with source paths, kit commit SHA, and SHA256 digests so CI (`./scripts/sync-kit.sh --check <repo>`) catches accidental drift immediately while keeping each plugin's `Cargo.lock` 100% standalone.

## For AI Agents

All Rust type signatures, JS bridge options, Panel QA gate flags, and selective `--files` / `--map` sync workflows live in the agent-facing reference:

> Tell your agent: *"Read [`llms.txt`](llms.txt) and [`docs/ai-guide.md`](docs/ai-guide.md) before syncing kit modules or wiring `agy-mcp-kit` invariants into an Antigravity plugin."*

## Safety & Privacy

- **Zero runtime network calls**: Both the Rust crate and JS panel kit make zero outbound network requests.
- **Strict PostMessage origin/source check**: `panel/bridge.js` drops every message where `ev.source !== window.parent` and supports strict `targetOrigin` pinning when the host origin is known (falling back to `"*"` only in opaque-origin sandboxes).
- **Fail-closed sanitization**: `scripts/check_sanitized.sh` scans both tracked working-tree files and the staged index, redacts matched line contents (`file:line` only), and never masks `git grep` exit errors.
- **Zero-side-effect tests**: `test_guard.rs` blocks live OS, display, browser, or billed cloud side effects at compile time during unit tests (`#[cfg(test)]` via vendored `ensure_not_in_test` or `guard_host_effect!` in downstream crates); pre-built binaries and subprocess integration tests must set `AGY_TEST_GUARD_DENY=1`.

## Documentation

- [AI Agent Guide & API Reference (`docs/ai-guide.md`)](docs/ai-guide.md)
- [LLM Index (`llms.txt`)](llms.txt) · [Kit Manifest (`kit-manifest.json`)](kit-manifest.json)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE)
