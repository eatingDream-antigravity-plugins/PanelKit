//! Canonical zero-bloat Rust runtime primitives for Antigravity MCP plugins.
//!
//! Each module is self-contained (requiring only `serde` and `serde_json`) so it
//! can be imported as a crate dependency or vendored directly via `scripts/sync-kit.sh`.

pub mod html_boot;
pub mod mcp_protocol;
pub mod swr_cache;
pub mod test_guard;

pub use html_boot::{
    escape_json_for_inline_script, serialize_boot_json, CompiledTemplate, HtmlLoader,
};
pub use mcp_protocol::{
    build_initialize_result, client_supports_mcp_apps, dispatch_jsonrpc, dispatch_jsonrpc_str,
    filter_tools_for_session, invalid_request_error, is_tool_allowed_in_catalog, jsonrpc_error,
    jsonrpc_ok, negotiate_protocol_version, parse_error, McpSession, ToolVisibility, APP_MIME,
    INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND,
    PARSE_ERROR, SUPPORTED_PROTOCOL_VERSIONS, UI_EXTENSION,
};
pub use swr_cache::{SwrCache, SwrConfig, SwrSnapshot};
pub use test_guard::{ensure_not_in_test, TEST_GUARD_ENV};
