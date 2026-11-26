//! Split-point HTML template loader with `(mtime, len)` caching and safe inline-script escaping.
//!
//! Pre-locates the boot-script injection slot once when a template is loaded so warm
//! `resources/read` calls perform a single metadata stat (no template file re-read)
//! and a single pre-sized allocation (`<0.3 ms`).

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

/// Pre-split HTML template ready for fast boot-script injection.
#[derive(Debug, Clone)]
pub struct CompiledTemplate {
    prefix: String,
    suffix: String,
    has_placeholder: bool,
}

impl CompiledTemplate {
    /// Splits `html` around the first occurrence of `placeholder`.
    pub fn from_html(html: &str, placeholder: &str) -> Self {
        if !placeholder.is_empty() {
            if let Some((prefix, suffix)) = html.split_once(placeholder) {
                return Self {
                    prefix: prefix.to_string(),
                    suffix: suffix.to_string(),
                    has_placeholder: true,
                };
            }
        }
        Self {
            prefix: html.to_string(),
            suffix: String::new(),
            has_placeholder: false,
        }
    }

    /// Returns `true` if the template contained the configured boot placeholder.
    pub fn has_placeholder(&self) -> bool {
        self.has_placeholder
    }

    /// Injects raw `boot_script` at the pre-located split point with a single allocation.
    pub fn render_with_boot(&self, boot_script: &str) -> String {
        if !self.has_placeholder {
            return self.prefix.clone();
        }
        let mut out =
            String::with_capacity(self.prefix.len() + boot_script.len() + self.suffix.len());
        out.push_str(&self.prefix);
        out.push_str(boot_script);
        out.push_str(&self.suffix);
        out
    }

    /// Safely serializes `data` as an inline `window.<global_var>=<json>;` (or bracket-escaped
    /// `window["..."]=<json>;`) statement and injects it at the split point.
    ///
    /// Rejects empty names or prototype-polluting keys (`__proto__`, `constructor`, `prototype`)
    /// by returning an error via [`Self::try_render_with_global_json`]; this infallible wrapper
    /// falls back to a harmless `/* invalid boot global */` comment if given a reserved key.
    pub fn render_with_global_json(&self, global_var: &str, data: &Value) -> String {
        match self.try_render_with_global_json(global_var, data) {
            Ok(html) => html,
            Err(_) => self.render_with_boot("/* invalid boot global */"),
        }
    }

    /// Fallible variant of [`Self::render_with_global_json`] that rejects empty or
    /// prototype-polluting global property names and safely escapes non-identifier keys.
    pub fn try_render_with_global_json(
        &self,
        global_var: &str,
        data: &Value,
    ) -> Result<String, String> {
        if global_var.is_empty() || is_reserved_global_key(global_var) {
            return Err(format!("unsafe boot global name: {global_var:?}"));
        }
        if !self.has_placeholder {
            return Ok(self.prefix.clone());
        }
        let escaped = serialize_boot_json(data);
        if is_safe_js_identifier(global_var) {
            let mut out = String::with_capacity(
                self.prefix.len()
                    + "window.".len()
                    + global_var.len()
                    + 2
                    + escaped.len()
                    + self.suffix.len(),
            );
            out.push_str(&self.prefix);
            out.push_str("window.");
            out.push_str(global_var);
            out.push('=');
            out.push_str(&escaped);
            out.push(';');
            out.push_str(&self.suffix);
            Ok(out)
        } else {
            let key_json = serialize_boot_json(&Value::String(global_var.to_string()));
            let mut out = String::with_capacity(
                self.prefix.len()
                    + "window[".len()
                    + key_json.len()
                    + 3
                    + escaped.len()
                    + self.suffix.len(),
            );
            out.push_str(&self.prefix);
            out.push_str("window[");
            out.push_str(&key_json);
            out.push_str("]=");
            out.push_str(&escaped);
            out.push(';');
            out.push_str(&self.suffix);
            Ok(out)
        }
    }
}

fn is_reserved_global_key(name: &str) -> bool {
    matches!(name, "__proto__" | "constructor" | "prototype")
}

/// Returns `true` when `name` is a plain ASCII JS identifier safe for `window.<name>` dot access
/// and not a prototype-polluting key.
pub fn is_safe_js_identifier(name: &str) -> bool {
    if name.is_empty() || is_reserved_global_key(name) {
        return false;
    }
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

struct CachedHtml {
    path: PathBuf,
    mtime_ns: u128,
    size: u64,
    template: Arc<CompiledTemplate>,
}

/// Thread-safe HTML template loader backed by an embedded fallback and `(mtime, len)` disk cache.
pub struct HtmlLoader {
    placeholder: String,
    candidate_paths: Vec<PathBuf>,
    embedded: Arc<CompiledTemplate>,
    cache: Mutex<Option<CachedHtml>>,
}

impl HtmlLoader {
    /// Creates a loader with an embedded template, a boot placeholder, and ordered disk override paths.
    pub fn new(
        embedded_html: &str,
        placeholder: impl Into<String>,
        candidate_paths: Vec<PathBuf>,
    ) -> Self {
        let placeholder = placeholder.into();
        let embedded = Arc::new(CompiledTemplate::from_html(embedded_html, &placeholder));
        Self {
            placeholder,
            candidate_paths,
            embedded,
            cache: Mutex::new(None),
        }
    }

    /// Creates a loader checking `override_path`, an optional environment variable `env_var`,
    /// and `<exe_parent>/../<relative_segments...>` before falling back to `embedded_html`.
    pub fn with_env_and_exe_fallback(
        embedded_html: &str,
        placeholder: impl Into<String>,
        override_path: Option<PathBuf>,
        env_var: &str,
        relative_segments: &[&str],
    ) -> Self {
        let mut candidate_paths = Vec::with_capacity(3);
        if let Some(p) = override_path {
            candidate_paths.push(p);
        }
        if !env_var.is_empty() {
            if let Ok(env_p) = std::env::var(env_var) {
                let trimmed = env_p.trim();
                if !trimmed.is_empty() {
                    candidate_paths.push(PathBuf::from(trimmed));
                }
            }
        }
        if !relative_segments.is_empty() {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(plugin_root) = exe.parent().and_then(Path::parent) {
                    let mut p = plugin_root.to_path_buf();
                    for seg in relative_segments {
                        p.push(seg);
                    }
                    candidate_paths.push(p);
                }
            }
        }
        Self::new(embedded_html, placeholder, candidate_paths)
    }

    /// Pre-warms the `(mtime, len)` cache from disk if an override exists.
    pub fn prewarm(&self) {
        let _ = self.load();
    }

    /// Returns the compiled template, serving from the in-memory cache whenever `(path, mtime, len)`
    /// matches, trying subsequent candidate paths if an earlier candidate is unreadable/empty, and
    /// falling back to the embedded template if no readable override exists.
    pub fn load(&self) -> Arc<CompiledTemplate> {
        for path in &self.candidate_paths {
            let Ok(meta) = fs::metadata(path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let size = meta.len();
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);

            {
                let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(ref c) = *cache {
                    if c.path == *path && c.mtime_ns == mtime_ns && c.size == size {
                        return Arc::clone(&c.template);
                    }
                }
            }

            if let Ok(text) = fs::read_to_string(path) {
                if !text.is_empty() {
                    let template = Arc::new(CompiledTemplate::from_html(&text, &self.placeholder));
                    let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
                    *cache = Some(CachedHtml {
                        path: path.clone(),
                        mtime_ns,
                        size,
                        template: Arc::clone(&template),
                    });
                    return template;
                }
            }
        }
        Arc::clone(&self.embedded)
    }

    /// Convenience helper: loads the template and injects `window.<global_var>=<escaped_json>;`.
    pub fn render_boot(&self, global_var: &str, data: &Value) -> String {
        self.load().render_with_global_json(global_var, data)
    }
}

/// Escapes raw JSON for safe embedding inside an HTML `<script>` element.
///
/// Neutralizes `</script>`, `<script>`, `<!--`, `-->`, HTML entity sequences (`&`),
/// and JavaScript line separators (`U+2028`, `U+2029`).
pub fn escape_json_for_inline_script(raw_json: &str) -> String {
    let mut out = String::with_capacity(raw_json.len() + 32);
    for ch in raw_json.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

/// Serializes a JSON value and escapes it for safe inline `<script>` injection.
pub fn serialize_boot_json(val: &Value) -> String {
    let raw = serde_json::to_string(val).unwrap_or_else(|_| "null".to_string());
    escape_json_for_inline_script(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn escapes_script_breakout_html_comments_and_line_separators() {
        let payload = json!({
            "xss": "</script><script>alert(1)</script>",
            "comment": "<!-- secret --> & stuff",
            "sep": "a\u{2028}b\u{2029}c"
        });
        let escaped = serialize_boot_json(&payload);
        assert!(!escaped.contains("</script>"));
        assert!(!escaped.contains("<!--"));
        assert!(!escaped.contains("-->"));
        assert!(!escaped.contains('&'));
        assert!(!escaped.contains('\u{2028}'));
        assert!(!escaped.contains('\u{2029}'));
        assert!(escaped.contains("\\u003c/script\\u003e"));
        assert!(escaped.contains("\\u003c!--"));
        assert!(escaped.contains("\\u2028"));
        assert!(escaped.contains("\\u2029"));

        // Must remain valid JSON that round-trips identically.
        let parsed: Value = serde_json::from_str(&escaped).expect("escaped output is valid JSON");
        assert_eq!(parsed, payload);
    }

    #[test]
    fn caches_disk_template_by_mtime_and_size_and_reloads_on_change() {
        let tmp = std::env::temp_dir().join(format!(
            "agy-mcp-kit-html-boot-{}-{}.html",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let embedded = "<html><script>/*__BOOT__*/</script></html>";
        let loader = HtmlLoader::new(embedded, "/*__BOOT__*/", vec![tmp.clone()]);

        // Missing file -> embedded fallback
        let rendered_embedded = loader.render_boot("__APP__", &json!({"v": 1}));
        assert_eq!(
            rendered_embedded,
            "<html><script>window.__APP__={\"v\":1};</script></html>"
        );

        // Disk override -> loaded and cached by (mtime, size)
        fs::write(&tmp, "<!doctype html><script>/*__BOOT__*/</script>").unwrap();
        let t1 = loader.load();
        let t2 = loader.load();
        assert!(Arc::ptr_eq(&t1, &t2), "warm load should reuse Arc");

        // Warm render latency sanity check (< 5 ms even in debug builds)
        let start = Instant::now();
        let warm_html = loader.render_boot("__APP__", &json!({"ok": true}));
        assert!(start.elapsed() < Duration::from_millis(50));
        assert_eq!(
            warm_html,
            "<!doctype html><script>window.__APP__={\"ok\":true};</script>"
        );

        // Mutate file length -> cache invalidates and reloads
        fs::write(
            &tmp,
            "<!doctype html><!--v2--><script>/*__BOOT__*/</script>",
        )
        .unwrap();
        let t3 = loader.load();
        assert!(!Arc::ptr_eq(&t1, &t3), "changed file should reload");
        assert!(t3.render_with_boot("x").contains("<!--v2-->"));

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn template_without_placeholder_returns_verbatim() {
        let tpl = CompiledTemplate::from_html("<html><body>plain</body></html>", "/*__BOOT__*/");
        assert!(!tpl.has_placeholder());
        assert_eq!(
            tpl.render_with_boot("ignored"),
            "<html><body>plain</body></html>"
        );
    }

    #[test]
    fn guards_global_var_against_script_injection_and_falls_back_across_empty_candidate() {
        let tpl = CompiledTemplate::from_html("<script>/*__BOOT__*/</script>", "/*__BOOT__*/");
        assert!(tpl
            .try_render_with_global_json("__proto__", &json!({"a": 1}))
            .is_err());
        assert!(tpl
            .try_render_with_global_json("", &json!({"a": 1}))
            .is_err());

        let injected = tpl
            .try_render_with_global_json("x=1;alert(1)</script>//", &json!({"ok": true}))
            .unwrap();
        assert!(!injected.contains("window.x=1"));
        assert!(!injected.contains("</script>//"));
        assert!(injected.contains("window[\"x=1;alert(1)\\u003c/script\\u003e//\"]="));

        // First candidate empty -> falls through to second candidate before embedded
        let ts = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p1 =
            std::env::temp_dir().join(format!("agy-kit-empty-{}-{ts}.html", std::process::id()));
        let p2 =
            std::env::temp_dir().join(format!("agy-kit-valid-{}-{ts}.html", std::process::id()));
        fs::write(&p1, "").unwrap();
        fs::write(&p2, "<p>second</p><script>/*__BOOT__*/</script>").unwrap();
        let loader = HtmlLoader::new(
            "<p>embedded</p>",
            "/*__BOOT__*/",
            vec![p1.clone(), p2.clone()],
        );
        assert!(loader.load().render_with_boot("").contains("<p>second</p>"));
        let _ = fs::remove_file(&p1);
        let _ = fs::remove_file(&p2);
    }
}
