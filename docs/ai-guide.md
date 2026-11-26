# agy-mcp-kit — AI Agent Guide & API Reference

`agy-mcp-kit` follows the **A+B Hybrid** model:
- **B (Canonical Source)**: All runtime primitives and panel standards live and are tested here (`cargo test --locked`, `node --test panel/test/kit.test.mjs`).
- **A (Zero-External-Dep Standalone Sync)**: Downstream plugins (`context-radar-mcp`, `mac-clamshell-mcp`, `chrome-stream-mcp`, `colab-mcp`) vendor only the files they need via `scripts/sync-kit.sh`, verified by SHA256 hashes in `.agy-kit-sync.json` and `kit-manifest.json`.

---

## 1. Rust Runtime Modules (`src/`)

Only depends on `serde` and `serde_json`. Every module is self-contained so it compiles cleanly whether imported from the `agy_mcp_kit` crate or vendored under `src/kit/` in a downstream plugin.

### `src/mcp_protocol.rs`
- **Constants**:
  - `SUPPORTED_PROTOCOL_VERSIONS = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]`
  - `LATEST_PROTOCOL_VERSION = "2025-11-25"`
  - `UI_EXTENSION = "io.modelcontextprotocol/ui"`
  - `APP_MIME = "text/html;profile=mcp-app"`
  - Error codes: `PARSE_ERROR (-32700)`, `INVALID_REQUEST (-32600)`, `METHOD_NOT_FOUND (-32601)`, `INVALID_PARAMS (-32602)`, `INTERNAL_ERROR (-32603)`
- **Session & Negotiation**:
  - `McpSession::default()` + `session.negotiate(&init_params) -> (&'static str, bool)`
  - `negotiate_protocol_version(Option<&str>) -> &'static str`
  - `client_supports_mcp_apps(&init_params) -> bool` — strict SEP-1865 check requiring `capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes` to be an array explicitly containing `"text/html;profile=mcp-app"`.
  - `build_initialize_result(name, version, protocol_version, apps_capable, extra_capabilities) -> Value`
- **Shared Tool Visibility (`tools/list` & `tools/call`)**:
  - `ToolVisibility::{ModelAndApp, AppOnly}` + `ToolVisibility::from_tool_json(&tool)`
  - `filter_tools_for_session(tools: &[Value], apps_capable: bool) -> Vec<Value>`
  - `is_tool_allowed_in_catalog(tool_name: &str, tools: &[Value], apps_capable: bool) -> bool`
- **JSON-RPC 2.0 Dispatch**:
  - `dispatch_jsonrpc(msg: &Value, handler) -> Option<Value>` — supports single requests, notifications (returns `None`), and batch arrays `[...]` (empty `[]` returns `-32600`; notification-only batch returns `None`).
  - `dispatch_jsonrpc_str(raw: &str, handler) -> Option<Value>` — returns `-32700` on invalid JSON.

### `src/swr_cache.rs`
- `SwrConfig { fresh_ttl, cold_wait_timeout, error_backoff, thread_name }`
- `SwrSnapshot<T> { value: Arc<T>, rev: u64, stale: bool }`
- `SwrCache::new(config, loader)`
  - `prewarm()` — spawns at most 1 background refresh thread without blocking.
  - `get_or_trigger_refresh() -> Result<SwrSnapshot<T>, String>` — returns `<1 ms` on warm hits (triggering single-flight background refresh if stale) and coalesces concurrent cold callers with optional bounded `cold_wait_timeout`.
  - `force_refresh_async() -> bool` — triggers background refresh even while fresh.
  - `invalidate()` — marks stale without dropping the cached value.
  - `set_value(value: T) -> u64` — installs a fresh value immediately (e.g. after mutations) and increments `rev`.
  - `current_rev() -> u64`, `is_unchanged(since_rev) -> bool`, `is_unchanged_and_revalidate(since_rev) -> bool` — enables 0-byte unchanged polling.

### `src/html_boot.rs`
- `CompiledTemplate::from_html(html, placeholder)`
  - `render_with_boot(boot_script) -> String`
  - `render_with_global_json(global_var, &data) -> String`
- `HtmlLoader::new(embedded_html, placeholder, candidate_paths)` & `HtmlLoader::with_env_and_exe_fallback(...)`
  - `prewarm()`, `load() -> Arc<CompiledTemplate>`, `render_boot(global_var, &data) -> String`
  - Caches disk overrides by `(path, mtime_ns, size)` with zero disk reads on warm hits.
- `escape_json_for_inline_script(raw_json)` & `serialize_boot_json(&val)` — escapes `<`, `>`, `&`, `U+2028`, `U+2029` to neutralize `</script>` and `<!--`.

### `src/test_guard.rs`
- `ensure_not_in_test(action: &str) -> Result<(), String>` — fails at compile time under `#[cfg(test)]` (when vendored in the target crate) and at runtime when `AGY_TEST_GUARD_DENY=1`.
- `guard_host_effect!("action")` — macro expanding `#[cfg(test)]` at the caller's crate site when consumed as a library dependency.

---

## 2. Canonical Panel Kit (`panel/`)

### `panel/tokens.css`
Defines all 16 Editorial-Warm two-letter tokens (`--bg`, `--s1`, `--s2`, `--s0`, `--t1`, `--t2`, `--t3`, `--ln`, `--l2`, `--sh`, `--ac`, `--ah`, `--ok`, `--wn`, `--er`, `--in`) plus `--tk`, `--sf`, `--sn`, `--mn`:
- Dark default `:root`: `#141311` background, `--ok: #4E9F72`.
- Light `:root[data-theme="light"]`: `#FAF8F4` background, `--ok: #2F7D53`.
- Includes `@media (prefers-reduced-motion: reduce)` and `:lang(zh-CN)` label reset; zero `prefers-color-scheme`, zero `opacity: 0` keyframes.

### `panel/bridge.js`
- `LATEST_PROTOCOL_VERSION = "2026-01-26"`
- `App(appInfo, appCapabilities, options)`:
  - Strict PostMessage check: drops any event where `!target || ev.source !== target` (`target = window.parent` when `window.parent !== window`).
  - `connect({ retries, retryDelayMs, timeoutMs })`: coalesced single-flight `ui/initialize` handshake validating exact `protocolVersion === "2026-01-26"`; retryable after failure or `close()`.
  - `hasServerTools()`: checks `hostCapabilities.serverTools`.
  - `callServerTool(params, opts)` & `callServerToolWithMetrics(params, opts)` -> `{ result, totalMs, serverMs, netRttMs }`, plus `getLastRttMs()` and `measureNetRttMs(totalMs, serverMs)`.
  - `onhostcontextchanged(delta, merged)`: invoked after live theme/luminance application (`applyHostContext`, `applyHostStyleVariables` with `>= 0.9` alpha guard on `--color-background-primary`).
  - `autoResize` defaults to `false` and only sends `ui/notifications/size-changed` when `autoResize: true` AND `hostContext.containerDimensions.maxHeight != null` (zero spam in side panes).

### `panel/guard.mjs`
- ESM API: `assertPanelInvariants(html, { maxBytes = 43500, hardMaxBytes = 46080, warnBytes = 44000, bootPlaceholder = null, skipJsParse = false })` and `checkPanelInvariants(html, opts)`.
- CLI: `node panel/guard.mjs <path/to/panel.html> [--max-bytes 43500]`.
- Enforces: byte budget, single inline `<script>` (syntax-checked), `default-src 'none'`, 0 external URLs, dark-first `<html>`/`<meta>`/`<body>` locks, 0 `prefers-color-scheme`, 0 `opacity:0` keyframes, 0 `.innerHTML`/`.outerHTML`, 0 `--buncss-*`, all 16 tokens in both themes + light `--ok: #2F7D53`, and `prefers-reduced-motion: reduce`.

---

## 3. Sync & Drift Tooling (`scripts/sync-kit.sh`)

```sh
# Refresh kit-manifest.json after editing canonical kit files
./scripts/sync-kit.sh --update-manifest

# Verify kit-manifest.json matches disk (runs in CI)
./scripts/sync-kit.sh --check-manifest

# Sync all canonical kit files into a target repo
./scripts/sync-kit.sh /path/to/plugin-repo

# Sync a selective subset with custom destination mapping
./scripts/sync-kit.sh \
  --files src/mcp_protocol.rs,panel/bridge.js,panel/guard.mjs \
  --map panel/bridge.js=panel/bridge.js \
  /path/to/plugin-repo

# Re-sync using the target repo's existing .agy-kit-sync.json file mapping
./scripts/sync-kit.sh /path/to/plugin-repo

# Verify zero drift in CI or pre-push
./scripts/sync-kit.sh --check /path/to/plugin-repo
```

Default destination map:
- `src/*.rs` -> `src/kit/*.rs`
- `panel/{tokens.css,bridge.js,guard.mjs}` -> `panel/kit/{tokens.css,bridge.js,guard.mjs}`
- `scripts/check_sanitized.sh` -> `scripts/check_sanitized.sh`
- `.github/sanitize-patterns.txt` -> `.github/sanitize-patterns.txt`
