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
#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub fn negotiate(&mut self, init_params: &Value) -> (&'static str, bool) {
        let requested = init_params.get("protocolVersion").and_then(Value::as_str);
        self.protocol_version = negotiate_protocol_version(requested);
        self.apps_capable = client_supports_mcp_apps(init_params);
        self.initialized = true;
        (self.protocol_version, self.apps_capable)
    }
}

/// Tool visibility class for shared `tools/list` and `tools/call` enforcement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolVisibility {
    /// Available to standard model clients and MCP Apps sessions alike.
    ModelAndApp,
    /// App-only tool (`_meta.ui.visibility: ["app"]`); requires SEP-1865 `apps_capable`.
    AppOnly,
}

impl ToolVisibility {
    /// Returns `true` if a tool with this visibility may be listed and invoked in the session.
    pub fn is_allowed(self, apps_capable: bool) -> bool {
        match self {
            ToolVisibility::ModelAndApp => true,
            ToolVisibility::AppOnly => apps_capable,
        }
    }

    /// Infers tool visibility from a serialized MCP tool definition's `_meta.ui.visibility`.
    ///
    /// A tool is treated as [`ToolVisibility::AppOnly`] if and only if `_meta.ui.visibility`
    /// is an array containing `"app"` and NOT containing `"model"`.
    pub fn from_tool_json(tool: &Value) -> Self {
        let vis = tool
            .get("_meta")
            .and_then(|m| m.get("ui"))
            .and_then(|u| u.get("visibility"))
            .and_then(Value::as_array);
        match vis {
            Some(arr) => {
                let has_app = arr.iter().any(|v| v.as_str() == Some("app"));
                let has_model = arr.iter().any(|v| v.as_str() == Some("model"));
                if has_app && !has_model {
                    ToolVisibility::AppOnly
                } else {
                    ToolVisibility::ModelAndApp
                }
            }
            None => ToolVisibility::ModelAndApp,
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
/// Only advertises `capabilities.extensions["io.modelcontextprotocol/ui"]` when
/// `apps_capable` is `true`.
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
                cap_obj.insert(k, v);
            }
        }
    }
    if apps_capable {
        capabilities["extensions"] = json!({
            UI_EXTENSION: {
                "mimeTypes": [APP_MIME]
            }
        });
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

/// Shared authorization check for `tools/call` against the same tool catalog used by `tools/list`.
///
/// Returns `true` only if `tool_name` exists in `tools` AND its visibility allows the session.
pub fn is_tool_allowed_in_catalog(tool_name: &str, tools: &[Value], apps_capable: bool) -> bool {
    tools.iter().any(|tool| {
        tool.get("name").and_then(Value::as_str) == Some(tool_name)
            && ToolVisibility::from_tool_json(tool).is_allowed(apps_capable)
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

fn dispatch_single_item<F>(item: &Value, handler: &mut F) -> Option<Value>
where
    F: FnMut(&Value) -> Option<Value>,
{
    let Some(obj) = item.as_object() else {
        return Some(invalid_request_error("Invalid Request"));
    };

    let id = obj.get("id").cloned();
    let valid_version = obj.get("jsonrpc").and_then(Value::as_str) == Some("2.0");
    let valid_method = obj
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|m| !m.is_empty());

    if !valid_version || !valid_method {
        return Some(jsonrpc_error(
            id.unwrap_or(Value::Null),
            INVALID_REQUEST,
            "Invalid Request",
        ));
    }

    let resp = handler(item);
    // JSON-RPC 2.0 notifications (absent `id`) MUST NOT emit a response.
    if id.is_none() {
        None
    } else {
        resp
    }
}

/// Dispatches either a single JSON-RPC 2.0 message or a batch array `[...]`.
///
/// Rules enforced:
/// - Empty batch `[]` returns `Some(-32600 Invalid Request)`.
/// - Notification-only single message or batch returns `None` (no wire reply).
/// - Mixed batches omit notifications and return only responses in a JSON array.
/// - Non-object entries or malformed requests return `-32600 Invalid Request`.
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
            .filter_map(|item| dispatch_single_item(item, &mut handler))
            .collect();
        if responses.is_empty() {
            None
        } else {
            Some(Value::Array(responses))
        }
    } else {
        dispatch_single_item(msg, &mut handler)
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
}
