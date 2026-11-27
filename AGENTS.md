# AGENTS.md

Guidance for AI coding agents working in `agy-mcp-kit` (**Panel Kit**). See [llms.txt](llms.txt) and [docs/ai-guide.md](docs/ai-guide.md) for API details and sync flags. Humans: see [README.md](README.md).

## Architecture

- `src/` (`lib.rs`, `mcp_protocol.rs`, `swr_cache.rs`, `html_boot.rs`, `test_guard.rs`) — Zero-bloat Rust MCP runtime primitives (`serde` + `serde_json` only; MSRV 1.75).
- `panel/` (`tokens.css`, `bridge.ts`, `guard.ts`, `test/kit.test.ts`) — Lucid Indigo dark-first panel tokens, strict `PostMessage` bridge, and browserless CSP/size/i18n guard.
- `scripts/sync-kit.sh`, `kit-manifest.json` — SHA-256 vendor sync (`--panel`, `--files`, `--map`, `--check`, `--update-manifest`, `--check-manifest`).
- `scripts/check_sanitized.sh`, `.github/sanitize-patterns.txt` — Redacted POSIX ERE sanitization guard synced across plugins.

## Build, Test & Security Gates (run before every PR)

```sh
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps && cargo test --locked
npm ci --ignore-scripts && npm run typecheck && npm test
bash scripts/sync-kit.sh --check-manifest && ./scripts/check_sanitized.sh
```

MSRV check (CI runs Rust `1.75.0`):
```sh
cargo +1.75.0 check --locked --all-targets
```

## Invariants

- Keep runtime dependencies minimal (`serde`, `serde_json`) with zero outbound network calls in Rust or `panel/` code.
- Run `./scripts/sync-kit.sh --update-manifest` after editing any canonical synced file listed in `kit-manifest.json`, and verify `bash scripts/sync-kit.sh --check-manifest` passes.
- Keep `panel/bridge.ts` strict on `ev.source === window.parent` and locked `targetOrigin`; keep `panel/guard.ts` enforcing `<= 64 KiB` (`65536 B`) single-script CSP and EN/ZH parity (`checkI18nParity`, `checkEnNoCjk`).
- Keep `src/test_guard.rs` blocking live OS, display, browser, or billed cloud side effects during tests (`AGY_TEST_GUARD_DENY=1`).
- Never commit personal paths, tokens, or emails (`./scripts/check_sanitized.sh` must exit 0).
