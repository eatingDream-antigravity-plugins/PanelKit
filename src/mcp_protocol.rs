//! Canonical MCP protocol negotiation, strict SEP-1865 Apps UI extension checks,
//! shared tool visibility enforcement, and JSON-RPC 2.0 single/batch dispatch.

use serde_json::{json, Value};

/// Supported MCP protocol versions in descending preference order.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// Latest MCP protocol version supported by this kit.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

/// SEP-1865 MCP Apps UI extension identifier.
pub const UI_EXTENSION: &str = "io.modelcontextprotocol/ui";

/// Canonical MIME type required by SEP-1865 for MCP App HTML resources.
pub const APP_MIME: &str = "text/html;profile=mcp-app";

/// JSON-RPC 2.0 Parse Error code.
pub const PARSE_ERROR: i64 = -32700;
/// JSON-RPC 2.0 Invalid Request code.
pub const INVALID_REQUEST: i64 = -32600;
/// JSON-RPC 2.0 Method Not Found code.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC 2.0 Invalid Params code.
pub const INVALID_PARAMS: i64 = -32602;
/// JSON-RPC 2.0 Internal Error code.
pub const INTERNAL_ERROR: i64 = -32603;

/// Negotiated per-connection MCP session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpSession {
    pub protocol_version: &'static str,
    pub apps_capable: bool,
    pub initialized: bool,
}

impl Default for McpSession {
    fn default() -> Self {
        Self {
            protocol_version: LATEST_PROTOCOL_VERSION,
            apps_capable: false,
            initialized: false,
        }
    }
}

impl McpSession {
    /// Negotiates protocol version and SEP-1865 MCP Apps capability from `initialize` params.
    ///
    /// If the session is already initialized, this returns the frozen negotiated state without
    /// mutating `protocol_version` or `apps_capable`.
    pub fn negotiate(&mut self, init_params: &Value) -> (&'static str, bool) {
        if self.initialized {
            return (self.protocol_version, self.apps_capable);
        }
        let requested = init_params.get("protocolVersion").and_then(Value::as_str);
        self.protocol_version = negotiate_protocol_version(requested);
        self.apps_capable = client_supports_mcp_apps(init_params);
        self.initialized = true;
        (self.protocol_version, self.apps_capable)
    }

    /// Strict MCP `initialize` validation and negotiation.
    ///
    /// Rejects duplicate `initialize` calls (`self.initialized == true`), non-object params,
    /// or missing/invalid `protocolVersion` (`String`), `capabilities` (`Object`), or
    /// `clientInfo.name` (`String`) without mutating session state.
    pub fn try_negotiate(
        &mut self,
        init_params: &Value,
    ) -> Result<(&'static str, bool), &'static str> {
        if self.initialized {
            return Err("session is already initialized");
        }
        let Some(obj) = init_params.as_object() else {
            return Err("initialize params must be an object");
        };
        let requested = obj
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or("initialize params missing string protocolVersion")?;
        if !obj.get("capabilities").is_some_and(Value::is_object) {
            return Err("initialize params missing object capabilities");
        }
        let client_name_ok = obj
            .get("clientInfo")
            .and_then(Value::as_object)
            .and_then(|ci| ci.get("name"))
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());
        if !client_name_ok {
            return Err("initialize params missing clientInfo.name");
        }
        self.protocol_version = negotiate_protocol_version(Some(requested));
        self.apps_capable = client_supports_mcp_apps(init_params);
        self.initialized = true;
        Ok((self.protocol_version, self.apps_capable))
    }

    /// Returns `true` if the negotiated MCP protocol version permits JSON-RPC batch arrays.
    ///
    /// MCP removed JSON-RPC batching starting in `2025-06-18`.
    pub fn supports_jsonrpc_batch(&self) -> bool {
        matches!(self.protocol_version, "2025-03-26" | "2024-11-05")
    }
}

/// Trusted origin of a `tools/call` invocation for caller-aware authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCaller {
    /// Invoked by the host model/agent session.
    Model,
    /// Invoked by an embedded SEP-1865 MCP App view over the host bridge.
    App,
}

/// Tool visibility class for shared `tools/list` and `tools/call` enforcement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolVisibility {
    /// Available to both model clients and MCP Apps views.
    ModelAndApp,
    /// Model-only tool (`_meta.ui.visibility: ["model"]`); hidden from app-only callers.
    ModelOnly,
    /// App-only tool (`_meta.ui.visibility: ["app"]`); requires SEP-1865 `apps_capable`.
    AppOnly,
    /// Fail-closed visibility when `_meta.ui.visibility` is present but malformed (non-array)
    /// or contains neither `"model"` nor `"app"`.
    Hidden,
}

impl ToolVisibility {
    /// Returns `true` if a tool with this visibility may be exposed in a session's tool catalog
    /// (`tools/list`) given whether the session negotiated SEP-1865 `apps_capable`.
    pub fn is_allowed(self, apps_capable: bool) -> bool {
        match self {
            ToolVisibility::ModelAndApp | ToolVisibility::ModelOnly => true,
            ToolVisibility::AppOnly => apps_capable,
            ToolVisibility::Hidden => false,
        }
    }

    /// Caller-aware authorization check distinguishing model calls from embedded MCP App calls.
    pub fn is_callable_by(self, caller: ToolCaller, apps_capable: bool) -> bool {
        match (self, caller) {
            (ToolVisibility::ModelAndApp, ToolCaller::Model) => true,
            (ToolVisibility::ModelAndApp, ToolCaller::App) => apps_capable,
            (ToolVisibility::ModelOnly, ToolCaller::Model) => true,
            (ToolVisibility::ModelOnly, ToolCaller::App) => false,
            (ToolVisibility::AppOnly, ToolCaller::Model) => false,
            (ToolVisibility::AppOnly, ToolCaller::App) => apps_capable,
            (ToolVisibility::Hidden, _) => false,
        }
    }

    /// Infers tool visibility from a serialized MCP tool definition's `_meta.ui.visibility`.
    ///
    /// - Absent `_meta.ui.visibility` -> [`ToolVisibility::ModelAndApp`]
    /// - `["app"]` (has `"app"`, not `"model"`) -> [`ToolVisibility::AppOnly`]
    /// - `["model"]` (has `"model"`, not `"app"`) -> [`ToolVisibility::ModelOnly`]
    /// - `["model", "app"]` -> [`ToolVisibility::ModelAndApp`]
    /// - Present non-array or array containing neither `"model"` nor `"app"` ->
    ///   [`ToolVisibility::Hidden`] (fails closed)
    pub fn from_tool_json(tool: &Value) -> Self {
        let vis = tool
            .get("_meta")
            .and_then(|m| m.get("ui"))
            .and_then(|u| u.get("visibility"));
        match vis {
            None => ToolVisibility::ModelAndApp,
            Some(Value::Array(arr)) => {
                let has_app = arr.iter().any(|v| v.as_str() == Some("app"));
                let has_model = arr.iter().any(|v| v.as_str() == Some("model"));
                match (has_model, has_app) {
                    (true, true) => ToolVisibility::ModelAndApp,
                    (false, true) => ToolVisibility::AppOnly,
                    (true, false) => ToolVisibility::ModelOnly,
                    (false, false) => ToolVisibility::Hidden,
                }
            }
            Some(_) => ToolVisibility::Hidden,
        }
    }
}

/// Negotiates an MCP protocol version against [`SUPPORTED_PROTOCOL_VERSIONS`].
///
/// If the client requests a supported version, that exact version is returned;
/// otherwise falls back to [`LATEST_PROTOCOL_VERSION`].
pub fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    if let Some(req) = requested {
        for &supported in SUPPORTED_PROTOCOL_VERSIONS {
            if supported == req {
                return supported;
            }
        }
    }
    LATEST_PROTOCOL_VERSION
}

/// Strict SEP-1865 negotiation check.
///
/// Returns `true` ONLY when `params.capabilities.extensions["io.modelcontextprotocol/ui"]`
/// is a JSON object whose `"mimeTypes"` property is a JSON array explicitly containing
/// `"text/html;profile=mcp-app"`.
pub fn client_supports_mcp_apps(init_params: &Value) -> bool {
    init_params
        .get("capabilities")
        .and_then(|c| c.get("extensions"))
        .and_then(|e| e.get(UI_EXTENSION))
        .and_then(Value::as_object)
        .and_then(|ui| ui.get("mimeTypes"))
        .and_then(Value::as_array)
        .is_some_and(|types| types.iter().any(|v| v.as_str() == Some(APP_MIME)))
}

/// Builds a standards-compliant MCP `initialize` result payload.
///
/// Merges `extra_capabilities` cleanly (preserving sibling entries under `extensions`)
/// and guarantees `capabilities.extensions["io.modelcontextprotocol/ui"]` is advertised
/// if and only if `apps_capable` is `true`.
pub fn build_initialize_result(
    server_name: &str,
    server_version: &str,
    protocol_version: &str,
    apps_capable: bool,
    extra_capabilities: Option<Value>,
) -> Value {
    let mut capabilities = json!({
        "tools": {},
        "resources": {}
    });
    if let Some(Value::Object(extra)) = extra_capabilities {
        if let Some(cap_obj) = capabilities.as_object_mut() {
            for (k, v) in extra {
                if k == "extensions" {
                    if let Value::Object(ext_map) = v {
                        let entry = cap_obj
                            .entry("extensions".to_string())
                            .or_insert_with(|| json!({}));
                        if let Some(existing_ext) = entry.as_object_mut() {
                            for (ek, ev) in ext_map {
                                existing_ext.insert(ek, ev);
                            }
                        }
                    }
                } else {
                    cap_obj.insert(k, v);
                }
            }
        }
    }
    if let Some(cap_obj) = capabilities.as_object_mut() {
        if apps_capable {
            let ext_val = cap_obj
                .entry("extensions".to_string())
                .or_insert_with(|| json!({}));
            if !ext_val.is_object() {
                *ext_val = json!({});
            }
            if let Some(ext_obj) = ext_val.as_object_mut() {
                ext_obj.insert(
                    UI_EXTENSION.to_string(),
                    json!({
                        "mimeTypes": [APP_MIME]
                    }),
                );
            }
        } else if let Some(ext_obj) = cap_obj.get_mut("extensions").and_then(Value::as_object_mut) {
            ext_obj.remove(UI_EXTENSION);
            if ext_obj.is_empty() {
                cap_obj.remove("extensions");
            }
        }
    }
    json!({
        "protocolVersion": protocol_version,
        "capabilities": capabilities,
        "serverInfo": {
            "name": server_name,
            "version": server_version
        }
    })
}

/// Filters a serialized tool catalog for `tools/list` using [`ToolVisibility::from_tool_json`].
pub fn filter_tools_for_session(tools: &[Value], apps_capable: bool) -> Vec<Value> {
    tools
        .iter()
        .filter(|tool| ToolVisibility::from_tool_json(tool).is_allowed(apps_capable))
        .cloned()
        .collect()
}

/// Session-level capability gate for `tools/call` against the same tool catalog used by `tools/list`.
///
/// Returns `true` only if `tool_name` exists in `tools` AND the session's `apps_capable` state
/// allows exposing it. When the server can distinguish model vs. embedded-app callers, prefer
/// [`is_tool_callable_by_in_catalog`].
pub fn is_tool_allowed_in_catalog(tool_name: &str, tools: &[Value], apps_capable: bool) -> bool {
    tools.iter().any(|tool| {
        tool.get("name").and_then(Value::as_str) == Some(tool_name)
            && ToolVisibility::from_tool_json(tool).is_allowed(apps_capable)
    })
}

/// Caller-aware authorization check for `tools/call` enforcing SEP-1865 `model` vs `app` visibility.
pub fn is_tool_callable_by_in_catalog(
    tool_name: &str,
    tools: &[Value],
    caller: ToolCaller,
    apps_capable: bool,
) -> bool {
    tools.iter().any(|tool| {
        tool.get("name").and_then(Value::as_str) == Some(tool_name)
            && ToolVisibility::from_tool_json(tool).is_callable_by(caller, apps_capable)
    })
}

/// Builds a JSON-RPC 2.0 success response object.
pub fn jsonrpc_ok(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

/// Builds a JSON-RPC 2.0 error response object.
pub fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into()
        }
    })
}

/// Builds a JSON-RPC 2.0 `-32600` Invalid Request response with `id: null`.
pub fn invalid_request_error(message: impl Into<String>) -> Value {
    jsonrpc_error(Value::Null, INVALID_REQUEST, message)
}

/// Builds a JSON-RPC 2.0 `-32700` Parse Error response with `id: null`.
pub fn parse_error(message: impl Into<String>) -> Value {
    jsonrpc_error(Value::Null, PARSE_ERROR, message)
}

fn is_valid_jsonrpc_id(val: &Value) -> bool {
    matches!(val, Value::String(_) | Value::Number(_) | Value::Null)
}

fn is_valid_mcp_id(val: &Value) -> bool {
    match val {
        Value::String(_) => true,
        Value::Number(n) => n.is_i64() || n.is_u64(),
        _ => false,
    }
}

fn is_valid_jsonrpc_params(val: &Value) -> bool {
    matches!(val, Value::Object(_) | Value::Array(_))
}

fn dispatch_single_item<F>(
    item: &Value,
    mcp_session: Option<McpSession>,
    handler: &mut F,
) -> Option<Value>
where
    F: FnMut(&Value) -> Option<Value>,
{
    let Some(obj) = item.as_object() else {
        return Some(invalid_request_error("Invalid Request"));
    };

    let strict_mcp_id = mcp_session.is_some();
    let raw_id = obj.get("id");
    let id_valid = match raw_id {
        None => true,
        Some(v) if strict_mcp_id => is_valid_mcp_id(v),
        Some(v) => is_valid_jsonrpc_id(v),
    };
    let safe_err_id = match raw_id {
        Some(v) if is_valid_jsonrpc_id(v) => v.clone(),
        _ => Value::Null,
    };

    let valid_version = obj.get("jsonrpc").and_then(Value::as_str) == Some("2.0");
    let method_str = obj
        .get("method")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty());
    let valid_params = obj.get("params").map_or(true, is_valid_jsonrpc_params);

    if !id_valid || !valid_version || method_str.is_none() || !valid_params {
        return Some(jsonrpc_error(
            if id_valid { safe_err_id } else { Value::Null },
            INVALID_REQUEST,
            "Invalid Request",
        ));
    }

    if let (Some(snap), Some(method)) = (mcp_session, method_str) {
        if method == "initialize" {
            let Some(req_id) = raw_id else {
                return Some(invalid_request_error(
                    "Invalid Request: initialize must be a request with an id",
                ));
            };
            if snap.initialized {
                return Some(jsonrpc_error(
                    req_id.clone(),
                    INVALID_REQUEST,
                    "Invalid Request: session is already initialized",
                ));
            }
        } else if !snap.initialized && method != "ping" {
            return raw_id.map(|req_id| {
                jsonrpc_error(
                    req_id.clone(),
                    INVALID_REQUEST,
                    "Invalid Request: session not initialized",
                )
            });
        }
    }

    let resp = handler(item);
    // JSON-RPC 2.0 notifications (absent `id`) MUST NOT emit a response.
    // Requests (present `id`) MUST always emit a response.
    raw_id.map(|req_id| {
        resp.unwrap_or_else(|| {
            jsonrpc_error(
                req_id.clone(),
                INTERNAL_ERROR,
                "Internal error: handler returned no response for request",
            )
        })
    })
}

/// Dispatches either a single JSON-RPC 2.0 message or a batch array `[...]`.
///
/// Rules enforced:
/// - Empty batch `[]` returns `Some(-32600 Invalid Request)`.
/// - Notification-only single message or batch returns `None` (no wire reply).
/// - Mixed batches omit notifications and return only responses in a JSON array.
/// - Non-object entries, invalid `id` types, scalar `params`, or malformed requests return
///   `-32600 Invalid Request` (never echoing invalid `id` values).
/// - Requests with a valid `id` always receive a response (`-32603` if handler returns `None`).
pub fn dispatch_jsonrpc<F>(msg: &Value, mut handler: F) -> Option<Value>
where
    F: FnMut(&Value) -> Option<Value>,
{
    if let Some(batch) = msg.as_array() {
        if batch.is_empty() {
            return Some(invalid_request_error("Invalid Request: empty batch"));
        }
        let responses: Vec<Value> = batch
            .iter()
            .filter_map(|item| dispatch_single_item(item, None, &mut handler))
            .collect();
        if responses.is_empty() {
            None
        } else {
            Some(Value::Array(responses))
        }
    } else {
        dispatch_single_item(msg, None, &mut handler)
    }
}

/// MCP-aware JSON-RPC 2.0 dispatcher enforcing protocol lifecycle and batching rules.
///
/// Takes `McpSession` by value (`Copy`), snapshotting `initialized` and `supports_jsonrpc_batch()`
/// before invoking `handler` so callers can mutate their `session` inside `handler` without
/// borrow conflicts (`E0502`).
///
/// In addition to [`dispatch_jsonrpc`] checks, this enforces:
/// - MCP request `id` MUST be a string or integer (never `null`, float, bool, array, or object).
/// - Pre-initialization requests other than `"initialize"` or `"ping"` are rejected with `-32600`.
/// - Duplicate `"initialize"` requests after initialization are rejected with `-32600`.
/// - JSON-RPC batch arrays are rejected when `initialize` is inside a batch (forbidden by MCP
///   `2025-03-26`) or when the negotiated session version is `2025-06-18` or newer (batching
///   removed from MCP).
pub fn dispatch_mcp_jsonrpc<F>(session: McpSession, msg: &Value, mut handler: F) -> Option<Value>
where
    F: FnMut(&Value) -> Option<Value>,
{
    let snap = session;
    let supports_batch = snap.supports_jsonrpc_batch();

    if let Some(batch) = msg.as_array() {
        if batch.is_empty() {
            return Some(invalid_request_error("Invalid Request: empty batch"));
        }
        let contains_initialize = batch.iter().any(|item| {
            item.as_object()
                .and_then(|o| o.get("method"))
                .and_then(Value::as_str)
                == Some("initialize")
        });
        if contains_initialize {
            return Some(invalid_request_error(
                "Invalid Request: initialize cannot be sent in a JSON-RPC batch",
            ));
        }
        if !supports_batch {
            return Some(invalid_request_error(format!(
                "Invalid Request: JSON-RPC batching is not supported in MCP {}",
                snap.protocol_version
            )));
        }
        let responses: Vec<Value> = batch
            .iter()
            .filter_map(|item| dispatch_single_item(item, Some(snap), &mut handler))
            .collect();
        if responses.is_empty() {
            None
        } else {
            Some(Value::Array(responses))
        }
    } else {
        dispatch_single_item(msg, Some(snap), &mut handler)
    }
}

/// Parses a raw JSON-RPC 2.0 text frame and dispatches it via [`dispatch_jsonrpc`].
///
/// Returns `Some(-32700 Parse Error)` on invalid JSON.
pub fn dispatch_jsonrpc_str<F>(raw: &str, handler: F) -> Option<Value>
where
    F: FnMut(&Value) -> Option<Value>,
{
    match serde_json::from_str::<Value>(raw) {
        Ok(val) => dispatch_jsonrpc(&val, handler),
        Err(e) => Some(parse_error(format!("Parse error: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_catalog() -> Vec<Value> {
        vec![
            json!({
                "name": "status_get",
                "description": "Public status tool"
            }),
            json!({
                "name": "panel_poll",
                "description": "App-only polling tool",
                "_meta": { "ui": { "visibility": ["app"] } }
            }),
            json!({
                "name": "panel_shared",
                "description": "Visible to both model and app",
                "_meta": { "ui": { "visibility": ["model", "app"] } }
            }),
        ]
    }

    #[test]
    fn negotiates_supported_versions_and_falls_back_to_latest() {
        for &v in SUPPORTED_PROTOCOL_VERSIONS {
            assert_eq!(negotiate_protocol_version(Some(v)), v);
        }
        assert_eq!(
            negotiate_protocol_version(Some("2099-01-01")),
            LATEST_PROTOCOL_VERSION
        );
        assert_eq!(negotiate_protocol_version(None), LATEST_PROTOCOL_VERSION);
    }

    #[test]
    fn enforces_strict_sep1865_mimetypes_negotiation() {
        // Valid: array explicitly containing "text/html;profile=mcp-app"
        let ok_params = json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {
                "extensions": {
                    "io.modelcontextprotocol/ui": {
                        "mimeTypes": ["text/plain", "text/html;profile=mcp-app"]
                    }
                }
            }
        });
        assert!(client_supports_mcp_apps(&ok_params));

        // Reject every non-compliant shape
        let invalid_cases = [
            json!({}),
            json!({"capabilities": {}}),
            json!({"capabilities": {"extensions": {"io.modelcontextprotocol/ui": true}}}),
            json!({"capabilities": {"extensions": {"io.modelcontextprotocol/ui": {}}}}),
            json!({"capabilities": {"extensions": {"io.modelcontextprotocol/ui": {"mimeTypes": "text/html;profile=mcp-app"}}}}),
            json!({"capabilities": {"extensions": {"io.modelcontextprotocol/ui": {"mimeTypes": []}}}}),
            json!({"capabilities": {"extensions": {"io.modelcontextprotocol/ui": {"mimeTypes": ["text/html"]}}}}),
            json!({"capabilities": {"extensions": {"io.modelcontextprotocol/ui": {"mimeTypes": ["text/html;profile=mcp-app;charset=utf-8"]}}}}),
        ];
        for case in &invalid_cases {
            assert!(
                !client_supports_mcp_apps(case),
                "should reject non-compliant SEP-1865 params: {case}"
            );
        }

        // build_initialize_result omits ui extension when apps_capable == false
        let res_no_apps = build_initialize_result("demo", "0.1.0", "2025-11-25", false, None);
        assert!(res_no_apps["capabilities"].get("extensions").is_none());

        let res_apps = build_initialize_result("demo", "0.1.0", "2025-11-25", true, None);
        assert_eq!(
            res_apps["capabilities"]["extensions"][UI_EXTENSION]["mimeTypes"],
            json!([APP_MIME])
        );
    }

    #[test]
    fn enforces_shared_tool_visibility_across_list_and_call() {
        let catalog = sample_catalog();

        // Standard (non-apps) session hides app-only tools in BOTH tools/list and tools/call
        let listed_plain = filter_tools_for_session(&catalog, false);
        let names_plain: Vec<&str> = listed_plain
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(names_plain, vec!["status_get", "panel_shared"]);
        assert!(is_tool_allowed_in_catalog("status_get", &catalog, false));
        assert!(is_tool_allowed_in_catalog("panel_shared", &catalog, false));
        assert!(!is_tool_allowed_in_catalog("panel_poll", &catalog, false));
        assert!(!is_tool_allowed_in_catalog("unknown_tool", &catalog, false));

        // Apps-capable session exposes app-only tools in BOTH tools/list and tools/call
        let listed_apps = filter_tools_for_session(&catalog, true);
        assert_eq!(listed_apps.len(), 3);
        assert!(is_tool_allowed_in_catalog("panel_poll", &catalog, true));
    }

    #[test]
    fn dispatches_single_and_batch_jsonrpc_with_spec_semantics() {
        let catalog = sample_catalog();
        let mut session = McpSession::default();

        let mut handle = |req: &Value| -> Option<Value> {
            let id = req.get("id")?.clone();
            let method = req["method"].as_str().unwrap_or("");
            let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
            match method {
                "initialize" => {
                    let (ver, apps) = session.negotiate(&params);
                    Some(jsonrpc_ok(
                        id,
                        build_initialize_result("kit-test", "0.1.0", ver, apps, None),
                    ))
                }
                "ping" => Some(jsonrpc_ok(id, json!({}))),
                "tools/call" => {
                    let name = params["name"].as_str().unwrap_or("");
                    if !is_tool_allowed_in_catalog(name, &catalog, session.apps_capable) {
                        return Some(jsonrpc_error(
                            id,
                            INVALID_PARAMS,
                            format!("Tool not available in this session: {name}"),
                        ));
                    }
                    Some(jsonrpc_ok(id, json!({"called": name})))
                }
                other => Some(jsonrpc_error(
                    id,
                    METHOD_NOT_FOUND,
                    format!("Not found: {other}"),
                )),
            }
        };

        // Empty batch -> -32600 Invalid Request
        let empty = dispatch_jsonrpc(&json!([]), &mut handle).expect("empty batch returns error");
        assert_eq!(empty["error"]["code"], INVALID_REQUEST);
        assert_eq!(empty["id"], Value::Null);

        // Notification-only batch -> None (no response)
        let notif_only = dispatch_jsonrpc(
            &json!([
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "method": "notifications/cancelled"}
            ]),
            &mut handle,
        );
        assert!(notif_only.is_none());

        // Mixed batch: initialize (non-apps) + notification + app-only tools/call (rejected!) + invalid item
        let mixed = dispatch_jsonrpc(
            &json!([
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "panel_poll"}},
                42,
                {"jsonrpc": "2.0", "id": 3, "method": "ping"}
            ]),
            &mut handle,
        )
        .expect("mixed batch returns array");

        let arr = mixed.as_array().expect("batch response is array");
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0]["id"], 1);
        assert_eq!(arr[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(arr[1]["id"], 2);
        assert_eq!(arr[1]["error"]["code"], INVALID_PARAMS);
        assert_eq!(arr[2]["id"], Value::Null);
        assert_eq!(arr[2]["error"]["code"], INVALID_REQUEST);
        assert_eq!(arr[3]["id"], 3);
        assert_eq!(arr[3]["result"], json!({}));

        // Invalid JSON -> -32700 Parse Error
        let bad_json = dispatch_jsonrpc_str("{not-json", &mut handle).expect("parse error");
        assert_eq!(bad_json["error"]["code"], PARSE_ERROR);
    }

    #[test]
    fn enforces_mcp_batch_rules_strict_ids_extensions_merge_and_caller_visibility() {
        // 1. build_initialize_result merges sibling extensions & strips UI_EXTENSION when apps_capable=false
        let extra = json!({
            "extensions": {
                "com.example/telemetry": { "enabled": true },
                "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] }
            }
        });
        let no_apps =
            build_initialize_result("demo", "0.1.0", "2025-11-25", false, Some(extra.clone()));
        assert_eq!(
            no_apps["capabilities"]["extensions"]["com.example/telemetry"]["enabled"],
            true
        );
        assert!(no_apps["capabilities"]["extensions"]
            .get(UI_EXTENSION)
            .is_none());

        let with_apps = build_initialize_result("demo", "0.1.0", "2025-11-25", true, Some(extra));
        assert_eq!(
            with_apps["capabilities"]["extensions"]["com.example/telemetry"]["enabled"],
            true
        );
        assert_eq!(
            with_apps["capabilities"]["extensions"][UI_EXTENSION]["mimeTypes"],
            json!([APP_MIME])
        );

        // 2. ModelOnly vs AppOnly vs ModelAndApp caller authorization
        let catalog = vec![
            json!({"name": "model_only", "_meta": {"ui": {"visibility": ["model"]}}}),
            json!({"name": "app_only", "_meta": {"ui": {"visibility": ["app"]}}}),
            json!({"name": "both", "_meta": {"ui": {"visibility": ["model", "app"]}}}),
        ];
        assert!(is_tool_callable_by_in_catalog(
            "model_only",
            &catalog,
            ToolCaller::Model,
            true
        ));
        assert!(!is_tool_callable_by_in_catalog(
            "model_only",
            &catalog,
            ToolCaller::App,
            true
        ));
        assert!(!is_tool_callable_by_in_catalog(
            "app_only",
            &catalog,
            ToolCaller::Model,
            true
        ));
        assert!(is_tool_callable_by_in_catalog(
            "app_only",
            &catalog,
            ToolCaller::App,
            true
        ));
        assert!(!is_tool_callable_by_in_catalog(
            "app_only",
            &catalog,
            ToolCaller::App,
            false
        ));

        // 3. try_negotiate validates required fields and leaves session uninitialized on error
        let mut session = McpSession::default();
        assert!(session.try_negotiate(&json!({})).is_err());
        assert!(!session.initialized);
        let (ver, apps) = session
            .try_negotiate(&json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1.0" }
            }))
            .unwrap();
        assert_eq!(ver, "2025-11-25");
        assert!(!apps);
        assert!(session.initialized);
        assert!(!session.supports_jsonrpc_batch());

        // 4. dispatch_mcp_jsonrpc rejects batches on 2025-11-25, null id, scalar params, and None responses
        let batch_err = dispatch_mcp_jsonrpc(
            session,
            &json!([{"jsonrpc": "2.0", "id": 1, "method": "ping"}]),
            |_| Some(jsonrpc_ok(json!(1), json!({}))),
        )
        .unwrap();
        assert_eq!(batch_err["error"]["code"], INVALID_REQUEST);

        let null_id_err = dispatch_mcp_jsonrpc(
            session,
            &json!({"jsonrpc": "2.0", "id": null, "method": "ping"}),
            |_| Some(jsonrpc_ok(Value::Null, json!({}))),
        )
        .unwrap();
        assert_eq!(null_id_err["error"]["code"], INVALID_REQUEST);

        let bad_params_err = dispatch_jsonrpc(
            &json!({"jsonrpc": "2.0", "id": [1], "method": "ping", "params": 123}),
            |_| Some(jsonrpc_ok(json!(1), json!({}))),
        )
        .unwrap();
        assert_eq!(bad_params_err["id"], Value::Null);
        assert_eq!(bad_params_err["error"]["code"], INVALID_REQUEST);

        let missing_resp_err = dispatch_mcp_jsonrpc(
            session,
            &json!({"jsonrpc": "2.0", "id": 7, "method": "ping"}),
            |_| None,
        )
        .unwrap();
        assert_eq!(missing_resp_err["id"], 7);
        assert_eq!(missing_resp_err["error"]["code"], INTERNAL_ERROR);

        // 5. Legacy 2025-03-26 session still rejects batched initialize
        let mut legacy = McpSession::default();
        legacy.negotiate(&json!({"protocolVersion": "2025-03-26"}));
        assert!(legacy.supports_jsonrpc_batch());
        let batched_init = dispatch_mcp_jsonrpc(
            legacy,
            &json!([{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}]),
            |_| Some(jsonrpc_ok(json!(1), json!({}))),
        )
        .unwrap();
        assert_eq!(batched_init["error"]["code"], INVALID_REQUEST);
    }

    #[test]
    fn fails_closed_on_malformed_or_empty_tool_visibility() {
        let hidden_cases = [
            json!({"name": "t1", "_meta": {"ui": {"visibility": "app"}}}),
            json!({"name": "t2", "_meta": {"ui": {"visibility": null}}}),
            json!({"name": "t3", "_meta": {"ui": {"visibility": []}}}),
            json!({"name": "t4", "_meta": {"ui": {"visibility": ["internal"]}}}),
            json!({"name": "t5", "_meta": {"ui": {"visibility": 42}}}),
        ];
        for tool in &hidden_cases {
            let vis = ToolVisibility::from_tool_json(tool);
            assert_eq!(vis, ToolVisibility::Hidden, "expected Hidden for {tool}");
            assert!(!vis.is_allowed(false));
            assert!(!vis.is_allowed(true));
            assert!(!vis.is_callable_by(ToolCaller::Model, false));
            assert!(!vis.is_callable_by(ToolCaller::Model, true));
            assert!(!vis.is_callable_by(ToolCaller::App, false));
            assert!(!vis.is_callable_by(ToolCaller::App, true));
        }

        // Absent visibility still defaults to ModelAndApp
        let absent = json!({"name": "open", "_meta": {"ui": {}}});
        assert_eq!(
            ToolVisibility::from_tool_json(&absent),
            ToolVisibility::ModelAndApp
        );
        assert!(filter_tools_for_session(&hidden_cases, true).is_empty());
        assert!(!is_tool_allowed_in_catalog("t1", &hidden_cases, true));
        assert!(!is_tool_callable_by_in_catalog(
            "t3",
            &hidden_cases,
            ToolCaller::App,
            true
        ));
    }

    #[test]
    fn enforces_session_lifecycle_blocks_pre_init_and_duplicate_initialize_without_borrow_conflict()
    {
        let mut session = McpSession::default();
        let mut handler_calls = 0usize;

        // Pre-init non-ping/non-initialize request is rejected with -32600 without invoking handler
        let pre_err = dispatch_mcp_jsonrpc(
            session,
            &json!({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "x"}}),
            |_| {
                handler_calls += 1;
                Some(jsonrpc_ok(json!(10), json!({})))
            },
        )
        .unwrap();
        assert_eq!(pre_err["id"], 10);
        assert_eq!(pre_err["error"]["code"], INVALID_REQUEST);
        assert_eq!(handler_calls, 0);

        // Pre-init notification is dropped silently (no wire response, no handler call)
        let pre_notif = dispatch_mcp_jsonrpc(
            session,
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            |_| {
                handler_calls += 1;
                None
            },
        );
        assert!(pre_notif.is_none());
        assert_eq!(handler_calls, 0);

        // Pre-init ping IS allowed
        let pre_ping = dispatch_mcp_jsonrpc(
            session,
            &json!({"jsonrpc": "2.0", "id": 11, "method": "ping"}),
            |req| Some(jsonrpc_ok(req["id"].clone(), json!({}))),
        )
        .unwrap();
        assert_eq!(pre_ping["id"], 11);
        assert_eq!(pre_ping["result"], json!({}));

        // First initialize mutates `session` directly inside `handler` (no E0502 because McpSession: Copy)
        let init_ok = dispatch_mcp_jsonrpc(
            session,
            &json!({
                "jsonrpc": "2.0",
                "id": 12,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {
                        "extensions": {
                            "io.modelcontextprotocol/ui": {
                                "mimeTypes": ["text/html;profile=mcp-app"]
                            }
                        }
                    },
                    "clientInfo": { "name": "kit-test" }
                }
            }),
            |req| {
                let (ver, apps) = session.try_negotiate(&req["params"]).unwrap();
                Some(jsonrpc_ok(
                    req["id"].clone(),
                    build_initialize_result("kit", "0.2.1", ver, apps, None),
                ))
            },
        )
        .unwrap();
        assert_eq!(init_ok["id"], 12);
        assert!(session.initialized);
        assert!(session.apps_capable);
        assert_eq!(session.protocol_version, "2025-11-25");

        // Duplicate initialize is rejected by BOTH try_negotiate and dispatch_mcp_jsonrpc
        assert!(session
            .try_negotiate(&json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "downgrade" }
            }))
            .is_err());
        let dup_init = dispatch_mcp_jsonrpc(
            session,
            &json!({
                "jsonrpc": "2.0",
                "id": 13,
                "method": "initialize",
                "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "downgrade" } }
            }),
            |_| {
                handler_calls += 1;
                Some(jsonrpc_ok(json!(13), json!({})))
            },
        )
        .unwrap();
        assert_eq!(dup_init["id"], 13);
        assert_eq!(dup_init["error"]["code"], INVALID_REQUEST);
        assert_eq!(handler_calls, 0);

        // Negotiated version & capabilities remain frozen (cannot downgrade to re-enable batching)
        assert_eq!(session.protocol_version, "2025-11-25");
        assert!(session.apps_capable);
        assert!(!session.supports_jsonrpc_batch());
        // Even direct negotiate() on initialized session preserves frozen state
        let (ver_after, apps_after) = session.negotiate(&json!({"protocolVersion": "2025-03-26"}));
        assert_eq!(ver_after, "2025-11-25");
        assert!(apps_after);
    }
}
