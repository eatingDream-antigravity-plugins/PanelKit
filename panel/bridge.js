// Canonical SEP-1865 (2026-01-26) MCP Apps PostMessage bridge.
// Features:
// - Strict ev.source === parent validation (rejects untrusted cross-window / self messages)
// - Coalesced & retry-capable ui/initialize handshake with exact protocolVersion check
// - serverTools capability detection
// - Live hostContext theme & luminance sync via onhostcontextchanged (>=0.9 alpha guard)
// - Net RTT measurement (totalMs - serverMs)
// - Zero size-changed RPC spam in fixed-height side panes

export const LATEST_PROTOCOL_VERSION = "2026-01-26";

const BG_VAR = "--color-background-primary";
const JSONRPC_VER = "2.0";
const UI_NOTIF_PREFIX = "ui/notifications/";

const rgbLuminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function parseAlpha(val, pct) {
  const a = pct === "%" ? Number(val) / 100 : Number(val);
  return Number.isFinite(a) ? a : null;
}

function parseColorAlphaLum(raw) {
  const s = String(raw || "").trim();
  const low = s.toLowerCase();
  if (!s || /^(transparent|none|initial|unset)$/.test(low)) return null;

  let m = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    const h = m[1];
    const short = h.length <= 4;
    const ch = (i) => parseInt(short ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    const a = h.length === 4 || h.length === 8 ? ch(3) / 255 : 1;
    return { a, lum: rgbLuminance(ch(0), ch(1), ch(2)) };
  }

  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]*)(%?))?\s*\)$/i);
  if (m) {
    const a = m[4] !== undefined && m[4] !== "" ? parseAlpha(m[4], m[5]) : 1;
    return a === null ? null : { a, lum: rgbLuminance(Number(m[1]), Number(m[2]), Number(m[3])) };
  }

  if (/^(hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(low)) {
    m = low.match(/\/\s*([\d.]*)(%?)\s*\)$/) || low.match(/^hsla?\([^,]+,[^,]+,[^,]+,\s*([\d.]*)(%?)\s*\)$/);
    if (m) {
      const a = parseAlpha(m[1], m[2]);
      return a === null ? null : { a, lum: null };
    }
    return { a: 1, lum: null };
  }

  if (low === "black") return { a: 1, lum: 0 };
  if (low === "white") return { a: 1, lum: 1 };

  // Fail closed on unrecognized color values so unparseable/transparent aliases cannot bypass alpha >= 0.9.
  return null;
}

/**
 * Returns relative luminance in [0, 1] for opaque/semi-opaque colors (alpha >= 0.5),
 * or null for transparent/unparseable colors.
 */
export function parseColorLum(raw) {
  const parsed = parseColorAlphaLum(raw);
  return parsed && parsed.a >= 0.5 && parsed.lum !== null ? parsed.lum : null;
}

/**
 * Computes net network/bridge round-trip time in milliseconds: max(0, totalMs - serverMs).
 */
export function measureNetRttMs(totalMs, serverMs = 0) {
  const total = Number.isFinite(totalMs) ? totalMs : 0;
  const srv = Number.isFinite(serverMs) ? serverMs : 0;
  return Math.max(0, Math.round(total - srv));
}

export function applyDocumentTheme(theme, doc = typeof document !== "undefined" ? document : null) {
  if ((theme !== "light" && theme !== "dark") || !doc?.documentElement) return;
  const el = doc.documentElement;
  const bg = `var(${BG_VAR},${theme === "light" ? "#FAF8F4" : "#141311"})`;
  if (el.getAttribute("data-theme") !== theme) el.setAttribute("data-theme", theme);
  el.style.colorScheme = theme;
  el.style.backgroundColor = bg;
  if (doc.body?.style) doc.body.style.backgroundColor = bg;
  const meta = doc.querySelector?.('meta[name="color-scheme"]');
  if (meta && meta.getAttribute("content") !== theme) meta.setAttribute("content", theme);
}

export function applyHostStyleVariables(vars, target = typeof document !== "undefined" ? document.documentElement : null) {
  if (!vars || typeof vars !== "object" || !target?.style) return;
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith("--") || v == null) continue;
    const val = String(v).trim();
    if (!val) continue;
    if (k === BG_VAR) {
      const parsed = parseColorAlphaLum(val);
      if (!parsed || parsed.a < 0.9) continue;
    }
    target.style.setProperty(k, val);
  }
}

export function applyHostFonts(css, doc = typeof document !== "undefined" ? document : null) {
  if (!css || !doc?.head) return;
  const id = "__mcp-host-fonts";
  let styleEl = doc.getElementById?.(id);
  if (!styleEl) {
    styleEl = doc.createElement("style");
    styleEl.id = id;
    doc.head.appendChild(styleEl);
  }
  if (styleEl.textContent !== css) styleEl.textContent = css;
}

export function applyHostContext(ctx, doc = typeof document !== "undefined" ? document : null) {
  if (!ctx || typeof ctx !== "object") return null;
  const styles = ctx.styles;
  if (styles?.variables && doc?.documentElement) {
    applyHostStyleVariables(styles.variables, doc.documentElement);
  }
  if (styles?.css?.fonts) {
    applyHostFonts(styles.css.fonts, doc);
  }
  const rawTheme = String(ctx.theme || "").trim().toLowerCase();
  let theme = /dark|night|black/.test(rawTheme)
    ? "dark"
    : /light|day|white/.test(rawTheme)
      ? "light"
      : null;
  if (!theme) {
    const bgVar =
      styles?.variables?.[BG_VAR] ||
      (typeof getComputedStyle === "function" && doc?.documentElement
        ? getComputedStyle(doc.documentElement).getPropertyValue(BG_VAR)
        : "");
    const lum = parseColorLum(bgVar);
    if (lum !== null) theme = lum < 0.45 ? "dark" : "light";
  }
  if (theme) applyDocumentTheme(theme, doc);
  return theme;
}

/**
 * Creates a SEP-1865 MCP Apps PostMessage bridge client.
 *
 * By default `autoResize` is `false` so fixed-height side panes emit zero `size-changed`
 * RPC traffic. Even when `autoResize: true` is passed, `size-changed` is only enabled
 * when the host explicitly provides `hostContext.containerDimensions.maxHeight`.
 */
export function App(appInfo, appCapabilities = {}, options = {}) {
  const win = options.window ?? (typeof window !== "undefined" ? window : null);
  const doc = options.document ?? (typeof document !== "undefined" ? document : null);
  const perfNow = options.perfNow ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const caps = appCapabilities || {};
  const autoResize = options.autoResize === true;
  const targetOrigin =
    typeof options.targetOrigin === "string" && options.targetOrigin.trim()
      ? options.targetOrigin.trim()
      : "*";
  const target =
    options.target !== undefined
      ? options.target
      : win && win.parent && win.parent !== win
        ? win.parent
        : null;

  const pending = new Map();
  const self = this || {};
  let hostCaps = null;
  let hostCtx = null;
  let nextId = 1;
  let initOk = false;
  let connEpoch = 0;
  let connPromise = null;
  let listening = false;
  let resizeObserver = null;
  let lastRttMs = null;

  const post = (payload) => {
    if (!target || typeof target.postMessage !== "function") {
      throw new Error("MCP host parent window unavailable");
    }
    target.postMessage(payload, targetOrigin);
  };

  const reply = (id, result, error) =>
    post(error ? { jsonrpc: JSONRPC_VER, id, error } : { jsonrpc: JSONRPC_VER, id, result });

  const attachListener = () => {
    if (!listening && win?.addEventListener) {
      win.addEventListener("message", onMessage);
      listening = true;
    }
  };

  const detachListener = () => {
    if (listening && win?.removeEventListener) {
      win.removeEventListener("message", onMessage);
      listening = false;
    }
  };

  async function onMessage(ev) {
    // Strictly validate event source (and targetOrigin when configured) against the parent host window.
    if (!target || !ev || ev.source !== target) return;
    if (targetOrigin !== "*" && ev.origin !== targetOrigin) return;
    const msg = ev.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== JSONRPC_VER) return;

    const method = msg.method;
    if (msg.id !== undefined && !method) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      entry.clearTimers();
      if (msg.error) {
        entry.reject(new Error(msg.error.message || "RPC error"));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && typeof method === "string") {
      try {
        if (method === "ping") return reply(msg.id, {});
        if (method === "ui/resource-teardown") {
          const res = self.onteardown ? (await self.onteardown(msg.params || {})) ?? {} : {};
          return reply(msg.id, res);
        }
        reply(msg.id, null, { code: -32601, message: "Method not found" });
      } catch (err) {
        reply(msg.id, null, { code: -32603, message: String(err) });
      }
      return;
    }

    if (typeof method === "string") {
      const params = msg.params || {};
      if (method.startsWith(UI_NOTIF_PREFIX)) {
        const key = method.slice(UI_NOTIF_PREFIX.length);
        if (key === "host-context-changed") {
          hostCtx = { ...(hostCtx || {}), ...params };
          applyHostContext(hostCtx, doc);
          self.onhostcontextchanged?.(params, hostCtx);
        } else {
          const handlerKey = {
            "tool-input": "ontoolinput",
            "tool-result": "ontoolresult",
            "tool-cancelled": "ontoolcancelled",
          }[key];
          if (handlerKey) self[handlerKey]?.(params);
        }
      } else if (method === "notifications/progress") {
        // Scope timer renewal strictly to the matching progressToken (never reset unrelated requests).
        const tok = params.progressToken;
        if (tok !== undefined && tok !== null) {
          for (const entry of pending.values()) {
            if (entry.progressToken !== null && entry.progressToken === tok) {
              entry.reset();
            }
          }
        }
      }
    }
  }

  function request(method, params, { timeoutMs = 75_000, maxTimeoutMs } = {}) {
    const id = nextId++;
    const rawTok = params?._meta?.progressToken;
    const progressToken =
      typeof rawTok === "string" || (typeof rawTok === "number" && Number.isFinite(rawTok))
        ? rawTok
        : null;
    const hardCapMs =
      Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0
        ? Math.max(timeoutMs, maxTimeoutMs)
        : Math.max(timeoutMs, timeoutMs * 4);

    return new Promise((resolve, reject) => {
      const expire = () => {
        if (!pending.delete(id)) return;
        entry.clearTimers();
        reject(new Error(`Timeout: ${method}`));
      };
      const startTimer = () => setTimeout(expire, timeoutMs);
      const entry = {
        resolve,
        reject,
        progressToken,
        timer: startTimer(),
        hardTimer: setTimeout(expire, hardCapMs),
        clearTimers() {
          clearTimeout(entry.timer);
          clearTimeout(entry.hardTimer);
        },
        reset() {
          clearTimeout(entry.timer);
          entry.timer = startTimer();
        },
      };
      pending.set(id, entry);
      try {
        post({ jsonrpc: JSONRPC_VER, id, method, params });
      } catch (err) {
        entry.clearTimers();
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notification(method, params) {
    post(params !== undefined ? { jsonrpc: JSONRPC_VER, method, params } : { jsonrpc: JSONRPC_VER, method });
  }

  function teardownPending(reason) {
    for (const entry of pending.values()) {
      entry.clearTimers();
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function resetConnectionState(reason) {
    initOk = false;
    hostCaps = null;
    hostCtx = null;
    detachListener();
    resizeObserver?.disconnect();
    resizeObserver = null;
    teardownPending(reason);
  }

  function close() {
    connEpoch += 1;
    connPromise = null;
    resetConnectionState("Closed");
  }

  async function callServerToolWithMetrics(params, opts = {}) {
    if (!initOk) {
      throw new Error("MCP bridge is not connected");
    }
    if (!self.hasServerTools()) {
      throw new Error("MCP host does not advertise serverTools capability");
    }
    const t0 = perfNow();
    const result = await request("tools/call", params, {
      timeoutMs: opts.timeout ?? 75_000,
      maxTimeoutMs: opts.maxTimeout,
    });
    const totalMs = Math.max(0, perfNow() - t0);
    const rawServerMs = result?.structuredContent?.serverMs ?? result?.serverMs;
    const serverMs = Number.isFinite(rawServerMs) ? Number(rawServerMs) : 0;
    const netRttMs = measureNetRttMs(totalMs, serverMs);
    lastRttMs = netRttMs;
    return { result, totalMs, serverMs, netRttMs };
  }

  function startAutoResizeIfInline() {
    // Side panes do not advertise containerDimensions.maxHeight; never spam size-changed there.
    const RO = options.ResizeObserver ?? (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
    if (!autoResize || hostCtx?.containerDimensions?.maxHeight == null || !RO || !doc?.documentElement) {
      return;
    }
    let queued = false;
    let lastW = 0;
    let lastH = 0;
    const root = doc.documentElement;
    const raf = win?.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0));
    const measure = () => {
      if (queued) return;
      queued = true;
      raf(() => {
        queued = false;
        const prev = root.style.height;
        root.style.height = "max-content";
        const h = Math.ceil(root.getBoundingClientRect().height);
        const w = Math.ceil(win?.innerWidth || 0);
        root.style.height = prev;
        if (w !== lastW || h !== lastH) {
          lastW = w;
          lastH = h;
          notification(`${UI_NOTIF_PREFIX}size-changed`, { width: w, height: h });
        }
      });
    };
    measure();
    resizeObserver = new RO(measure);
    resizeObserver.observe(root);
    if (doc.body) resizeObserver.observe(doc.body);
  }

  function connect(connectOpts = {}) {
    if (initOk) return Promise.resolve();
    if (connPromise) return connPromise;

    const myEpoch = connEpoch;
    const maxRetries = Math.max(0, Number(connectOpts.retries ?? 0));
    const retryDelayMs = Math.max(0, Number(connectOpts.retryDelayMs ?? 200));
    const timeoutMs = Number(connectOpts.timeoutMs ?? 20_000);

    const p = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (myEpoch !== connEpoch) {
          throw new Error("Closed");
        }
        attachListener();
        try {
          const res = await request(
            "ui/initialize",
            { appInfo, appCapabilities: caps, protocolVersion: LATEST_PROTOCOL_VERSION },
            { timeoutMs }
          );
          if (myEpoch !== connEpoch) {
            throw new Error("Closed");
          }
          if (!res || typeof res !== "object" || res.protocolVersion !== LATEST_PROTOCOL_VERSION) {
            throw new Error(`Unsupported protocol version: ${res?.protocolVersion ?? "missing"}`);
          }
          hostCaps = res.hostCapabilities || {};
          hostCtx = res.hostContext || null;
          initOk = true;
          applyHostContext(hostCtx, doc);
          notification(`${UI_NOTIF_PREFIX}initialized`);
          startAutoResizeIfInline();
          return;
        } catch (err) {
          lastErr = err;
          if (myEpoch !== connEpoch) {
            throw new Error("Closed");
          }
          resetConnectionState("Handshake retry");
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            if (myEpoch !== connEpoch) {
              throw new Error("Closed");
            }
          }
        }
      }
      throw lastErr;
    })().finally(() => {
      if (connPromise === p) {
        connPromise = null;
      }
    });

    connPromise = p;
    return p;
  }

  return Object.assign(self, {
    isConnected: () => initOk,
    hasServerTools: () => Boolean(hostCaps?.serverTools && typeof hostCaps.serverTools === "object"),
    getHostCapabilities: () => hostCaps,
    getHostContext: () => hostCtx,
    getLastRttMs: () => lastRttMs,
    request,
    notification,
    close,
    connect,
    callServerTool: (params, opts = {}) => callServerToolWithMetrics(params, opts).then((r) => r.result),
    callServerToolWithMetrics,
  });
}
