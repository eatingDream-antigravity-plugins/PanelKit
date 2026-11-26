import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  App,
  LATEST_PROTOCOL_VERSION,
  applyHostContext,
  applyHostStyleVariables,
  measureNetRttMs,
  parseColorLum,
} from "../bridge.js";
import {
  DEFAULT_MAX_BYTES,
  FAMILY_TOKENS,
  assertPanelInvariants,
  checkPanelInvariants,
} from "../guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const TOKENS_CSS = fs.readFileSync(path.join(REPO_ROOT, "panel", "tokens.css"), "utf8");

function makeFakeEnv() {
  const winListeners = new Map();
  const attrs = new Map();
  const styleProps = new Map();
  const metaAttrs = new Map([["content", "dark"]]);
  const sentToParent = [];

  const doc = {
    documentElement: {
      style: {
        colorScheme: "dark",
        backgroundColor: "#141311",
        height: "",
        setProperty: (k, v) => styleProps.set(k, v),
      },
      getAttribute: (k) => attrs.get(k) ?? null,
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getBoundingClientRect: () => ({ width: 380, height: 420 }),
    },
    body: { style: { backgroundColor: "#141311" } },
    head: { children: [], appendChild(el) { this.children.push(el); } },
    querySelector: (sel) =>
      sel.includes('meta[name="color-scheme"]')
        ? {
            getAttribute: (k) => metaAttrs.get(k) ?? null,
            setAttribute: (k, v) => metaAttrs.set(k, String(v)),
          }
        : null,
    getElementById: () => null,
    createElement: (tag) => ({ tag, id: "", textContent: "" }),
  };

  const parent = {
    postMessage(msg, origin) {
      sentToParent.push({ msg, origin });
    },
  };

  const win = {
    parent,
    innerWidth: 380,
    requestAnimationFrame: (fn) => fn(),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      winListeners.set(type, (winListeners.get(type) || []).filter((f) => f !== fn));
    },
    emit(type, ev) {
      for (const fn of [...(winListeners.get(type) || [])]) fn(ev);
    },
  };

  return { win, doc, parent, sentToParent, attrs, styleProps, metaAttrs };
}

function buildValidPanelHtml(overrides = {}) {
  const css = overrides.css ?? TOKENS_CSS;
  const htmlTag = overrides.htmlTag ?? '<html lang="en" style="background:#141311;color-scheme:dark">';
  const metaTag = overrides.metaTag ?? '<meta name="color-scheme" content="dark">';
  const cspTag = overrides.cspTag ?? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`;
  const bodyTag = overrides.bodyTag ?? '<body style="background:#141311">';
  const scriptBlock = overrides.scriptBlock ?? "<script>/*__BOOT__*/const ok=1;</script>";
  return `<!doctype html>${htmlTag}<head>${metaTag}${cspTag}<style>${css}</style></head>${bodyTag}<main>Panel</main>${scriptBlock}</body></html>`;
}

describe("agy-mcp-kit Panel Bridge (SEP-1865)", () => {
  it("validates ev.source strictly, supports coalesced/retried ui/initialize, detects serverTools, and measures RTT", async () => {
    const env = makeFakeEnv();
    let clockMs = 1000;
    let initAttempts = 0;

    const parent = {
      postMessage(msg) {
        env.sentToParent.push(msg);
        if (msg.method === "ui/initialize") {
          initAttempts += 1;
          if (initAttempts === 1) {
            // First attempt fails with wrong protocol version -> retry must recover
            setImmediate(() =>
              env.win.emit("message", {
                source: parent,
                data: { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2020-01-01" } },
              })
            );
            return;
          }
          // Send a spoofed message from an untrusted window first — MUST be ignored
          setImmediate(() => {
            env.win.emit("message", {
              source: { untrusted: true },
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  hostCapabilities: {},
                  hostContext: { theme: "light" },
                },
              },
            });
            // Then send authentic parent response
            env.win.emit("message", {
              source: parent,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  hostCapabilities: { serverTools: {} },
                  hostContext: { theme: "dark", styles: { variables: { "--color-background-primary": "#141311" } } },
                },
              },
            });
          });
        } else if (msg.method === "tools/call") {
          setImmediate(() => {
            clockMs += 58;
            env.win.emit("message", {
              source: parent,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: { structuredContent: { ok: true, serverMs: 12 } },
              },
            });
          });
        }
      },
    };
    env.win.parent = parent;

    const app = App(
      { name: "kit-panel", version: "0.1.0" },
      {},
      { window: env.win, document: env.doc, perfNow: () => clockMs }
    );

    // Concurrent connect() calls coalesce into a single in-flight handshake attempt with retry
    const p1 = app.connect({ retries: 1, retryDelayMs: 5 });
    const p2 = app.connect({ retries: 1, retryDelayMs: 5 });
    assert.equal(p1, p2);
    await p1;

    assert.equal(initAttempts, 2);
    assert.equal(app.isConnected(), true);
    assert.equal(app.hasServerTools(), true);
    assert.equal(env.attrs.get("data-theme"), "dark");

    // Zero size-changed RPC spam in side panes
    assert.equal(
      env.sentToParent.some((m) => m.method === "ui/notifications/size-changed"),
      false,
      "side panes must emit zero size-changed notifications"
    );

    // RTT measurement = totalMs (58) - serverMs (12) = 46ms
    const metrics = await app.callServerToolWithMetrics({ name: "demo_poll", arguments: {} });
    assert.equal(metrics.totalMs, 58);
    assert.equal(metrics.serverMs, 12);
    assert.equal(metrics.netRttMs, 46);
    assert.equal(app.getLastRttMs(), 46);
    assert.equal(measureNetRttMs(10, 25), 0);

    // Live hostContext theme sync via onhostcontextchanged (ignores untrusted source!)
    let ctxEvents = 0;
    app.onhostcontextchanged = () => {
      ctxEvents += 1;
    };
    env.win.emit("message", {
      source: env.win, // self-window spoofing MUST be rejected
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "light" },
      },
    });
    assert.equal(ctxEvents, 0);
    assert.equal(env.attrs.get("data-theme"), "dark");

    env.win.emit("message", {
      source: parent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "light" },
      },
    });
    assert.equal(ctxEvents, 1);
    assert.equal(env.attrs.get("data-theme"), "light");
    assert.equal(env.metaAttrs.get("content"), "light");

    app.close();
    assert.equal(app.isConnected(), false);
    assert.equal(app.hasServerTools(), false);
  });

  it("detects missing serverTools capability and enforces alpha >= 0.9 guard on --color-background-primary", async () => {
    const env = makeFakeEnv();
    const parent = {
      postMessage(msg) {
        if (msg.method === "ui/initialize") {
          setImmediate(() =>
            env.win.emit("message", {
              source: parent,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  hostCapabilities: {},
                  hostContext: { styles: { variables: { "--color-background-primary": "#FAF8F4" } } },
                },
              },
            })
          );
        }
      },
    };
    env.win.parent = parent;

    const app = App({ name: "no-tools", version: "0.1.0" }, {}, { window: env.win, document: env.doc });
    await app.connect();
    assert.equal(app.hasServerTools(), false);
    assert.equal(env.attrs.get("data-theme"), "light"); // inferred from luminance > 0.45

    // Alpha < 0.9 guard
    const props = new Map();
    const fakeEl = { style: { setProperty: (k, v) => props.set(k, v) } };
    for (const bad of ["transparent", "rgba(0,0,0,0)", "rgba(255,255,255,0.89)", "#14131180", "#fff0"]) {
      applyHostStyleVariables({ "--color-background-primary": bad }, fakeEl);
      assert.equal(props.has("--color-background-primary"), false, `should reject ${bad}`);
    }
    applyHostStyleVariables({ "--color-background-primary": "rgba(20, 19, 17, 0.95)" }, fakeEl);
    assert.equal(props.get("--color-background-primary"), "rgba(20, 19, 17, 0.95)");

    assert.equal(parseColorLum("transparent"), null);
    assert.ok(parseColorLum("#141311") < 0.2);
    assert.ok(parseColorLum("#FAF8F4") > 0.9);
    assert.equal(applyHostContext({ theme: "dark" }, env.doc), "dark");

    // Calling callServerTool without serverTools capability must reject cleanly
    await assert.rejects(
      () => app.callServerTool({ name: "demo", arguments: {} }),
      /serverTools/
    );
    app.close();
    // Calling callServerTool after close() must reject as disconnected
    await assert.rejects(
      () => app.callServerTool({ name: "demo", arguments: {} }),
      /not connected/
    );
  });

  it("cancels in-flight connect() retries on close(), pins targetOrigin, and scopes progress timers by token", async () => {
    const env = makeFakeEnv();
    let attempts = 0;
    const parent = {
      postMessage(msg, origin) {
        env.sentToParent.push({ msg, origin });
        if (msg.method === "ui/initialize") {
          attempts += 1;
          setTimeout(() => {
            env.win.emit("message", {
              source: parent,
              origin: "https://trusted.host",
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: "2020-01-01",
                  hostCapabilities: { serverTools: {} },
                },
              },
            });
          }, 5);
        }
      },
    };
    env.win.parent = parent;

    const app = App(
      { name: "cancel-test", version: "0.1.0" },
      {},
      { window: env.win, document: env.doc, targetOrigin: "https://trusted.host" }
    );
    const conn = app.connect({ retries: 3, retryDelayMs: 25, timeoutMs: 500 });
    // Close during the first handshake attempt -> must cancel retries and never become connected
    app.close();
    await assert.rejects(() => conn, /Closed/);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(attempts, 1);
    assert.equal(app.isConnected(), false);
    assert.equal(app.getHostContext(), null);
    assert.equal(env.sentToParent[0].origin, "https://trusted.host");

    // Progress notification for token A must NOT keep token B alive forever
    const env2 = makeFakeEnv();
    const parent2 = {
      postMessage(msg) {
        if (msg.method === "ui/initialize") {
          setImmediate(() =>
            env2.win.emit("message", {
              source: parent2,
              origin: "https://trusted.host",
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: { protocolVersion: LATEST_PROTOCOL_VERSION, hostCapabilities: { serverTools: {} } },
              },
            })
          );
        }
      },
    };
    env2.win.parent = parent2;
    const app2 = App(
      { name: "prog-test", version: "0.1.0" },
      {},
      { window: env2.win, document: env2.doc, targetOrigin: "https://trusted.host" }
    );
    await app2.connect();
    const slowReq = app2.request("tools/call", { name: "b", _meta: { progressToken: "tok-B" } }, { timeoutMs: 35 });
    const interval = setInterval(() => {
      env2.win.emit("message", {
        source: parent2,
        origin: "https://trusted.host",
        data: { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "tok-A", progress: 1 } },
      });
    }, 10);
    await assert.rejects(() => slowReq, /Timeout: tools\/call/);
    clearInterval(interval);
    app2.close();
  });

  it("hardens color/alpha parsing, cancels retry sleep immediately on close(), locks ev.origin, deep-merges styles, and guards request()/callbacks", async () => {
    // 1. Fail-closed color/alpha parsing (no bypasses on none/scientific/var/dots)
    const props = new Map();
    const fakeEl = { style: { setProperty: (k, v) => props.set(k, v) } };
    for (const bad of [
      "oklch(0.2 0 0 / none)",
      "hsl(0 0% 0% / 5e-2)",
      "color(srgb 0 0 0 / var(--zero))",
      "rgb(. . .)",
      "rgba(0, 0, 0, .)",
      "hsl(0, 0%, 0%, none)",
      "oklch(0.2 0 0 / 0.5",
    ]) {
      applyHostStyleVariables({ "--color-background-primary": bad }, fakeEl);
      assert.equal(props.has("--color-background-primary"), false, `should reject ${bad}`);
    }
    assert.equal(parseColorLum("rgb(. . .)"), null);
    assert.equal(parseColorLum("rgb(10, 20, 30)"), (0.2126 * 10 + 0.7152 * 20 + 0.0722 * 30) / 255);
    applyHostStyleVariables({ "--color-background-primary": "oklch(0.2 0 0 / 0.95)" }, fakeEl);
    assert.equal(props.get("--color-background-primary"), "oklch(0.2 0 0 / 0.95)");

    // 2. close() during retryDelayMs sleep cancels timer immediately (< 50ms for 600ms delay)
    const env = makeFakeEnv();
    const parent = {
      postMessage(msg, origin) {
        env.sentToParent.push({ msg, origin });
        if (msg.method === "ui/initialize") {
          setImmediate(() =>
            env.win.emit("message", {
              source: parent,
              origin: "https://host.example",
              data: { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2020-01-01" } },
            })
          );
        }
      },
    };
    env.win.parent = parent;
    const app = App({ name: "retry-sleep", version: "0.2.1" }, {}, { window: env.win, document: env.doc });

    // request() before connect() rejects immediately
    await assert.rejects(() => app.request("tools/call", { name: "x" }), /not connected/);

    const connP = app.connect({ retries: 2, retryDelayMs: 600, timeoutMs: Number.NaN });
    await new Promise((r) => setTimeout(r, 15));
    const t0 = Date.now();
    app.close();
    await assert.rejects(() => connP, /Closed/);
    assert.ok(Date.now() - t0 < 150, "close() must cancel retry sleep timer immediately");

    // 3. Post-init origin locking + deep-merged hostCtx.styles.{variables,css} + throwing callback isolation
    const env2 = makeFakeEnv();
    const parent2 = {
      postMessage(msg, origin) {
        env2.sentToParent.push({ msg, origin });
        if (msg.method === "ui/initialize") {
          setImmediate(() =>
            env2.win.emit("message", {
              source: parent2,
              origin: "https://locked-host.example",
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  hostCapabilities: { serverTools: {} },
                  hostContext: {
                    theme: "dark",
                    styles: {
                      variables: { "--color-background-primary": "#141311", "--keep-var": "1" },
                      css: { fonts: "@font-face { font-family: A; }" },
                    },
                  },
                },
              },
            })
          );
        }
      },
    };
    env2.win.parent = parent2;
    const app2 = App({ name: "origin-lock", version: "0.2.1" }, {}, { window: env2.win, document: env2.doc });
    await app2.connect();

    // Post-init notifications use locked origin instead of "*"
    const initNotif = env2.sentToParent.find((m) => m.msg.method === "ui/notifications/initialized");
    assert.equal(initNotif.origin, "https://locked-host.example");

    // Spoofed origin after lock is ignored even with matching source
    env2.win.emit("message", {
      source: parent2,
      origin: "https://evil.example",
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "light" },
      },
    });
    assert.equal(app2.getHostContext().theme, "dark");

    // Deep-merge preserves existing styles.variables and styles.css.fonts, and throwing callback does not reject
    app2.onhostcontextchanged = () => {
      throw new Error("boom in user callback");
    };
    env2.win.emit("message", {
      source: parent2,
      origin: "https://locked-host.example",
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { styles: { variables: { "--new-var": "2" }, css: { extra: "body{}" } } },
      },
    });
    await new Promise((r) => setImmediate(r));
    const merged = app2.getHostContext();
    assert.equal(merged.styles.variables["--keep-var"], "1");
    assert.equal(merged.styles.variables["--new-var"], "2");
    assert.equal(merged.styles.css.fonts, "@font-face { font-family: A; }");
    assert.equal(merged.styles.css.extra, "body{}");
    app2.close();
  });
});

describe("agy-mcp-kit Panel QA Gate (guard.mjs) & tokens.css", () => {
  it("passes on canonical tokens.css + valid Editorial-Warm HTML", () => {
    const html = buildValidPanelHtml();
    const report = assertPanelInvariants(html, {
      maxBytes: DEFAULT_MAX_BYTES,
      bootPlaceholder: "/*__BOOT__*/",
    });
    assert.equal(report.ok, true);
    assert.ok(report.bytes < DEFAULT_MAX_BYTES);
    assert.equal(FAMILY_TOKENS.length, 16);

    // Valid CSP where a quoted directive precedes default-src 'none' MUST pass
    const reorderedCsp = buildValidPanelHtml({
      cspTag: `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'; default-src 'none'; style-src 'unsafe-inline'">`,
    });
    assert.equal(checkPanelInvariants(reorderedCsp).ok, true);

    // Multiple <style> blocks splitting dark/light tokens AND CSS comment containing '}' inside :root MUST pass
    const splitStyles = buildValidPanelHtml({
      css: "",
    }).replace(
      "<style></style>",
      `<style>${TOKENS_CSS.slice(0, TOKENS_CSS.indexOf(":root[data-theme")).replace("--bg:", "/* } */\n  --bg:")}</style><style>${TOKENS_CSS.slice(TOKENS_CSS.indexOf(":root[data-theme"))}</style>`
    );
    assert.equal(checkPanelInvariants(splitStyles).ok, true);
  });

  it("rejects every single invariant violation cleanly", () => {
    const cases = [
      ["byte budget exceeded", buildValidPanelHtml(), { maxBytes: 100 }],
      ["multiple scripts", buildValidPanelHtml({ scriptBlock: "<script>1</script><script>2</script>" }), {}],
      ["missing CSP", buildValidPanelHtml({ cspTag: "" }), {}],
      ["CSP outside head", buildValidPanelHtml({ cspTag: "", bodyTag: '<body style="background:#141311"><!-- default-src \'none\' -->' }), {}],
      ["commented-out CSP in head", buildValidPanelHtml({ cspTag: `<!-- <meta http-equiv="Content-Security-Policy" content="default-src 'none'"> -->` }), {}],
      ["loose CSP default-src 'none' *", buildValidPanelHtml({ cspTag: `<meta http-equiv="Content-Security-Policy" content="default-src 'none' *">` }), {}],
      ["external URL", buildValidPanelHtml({ scriptBlock: '<script>const u="https://user:secret@cdn.example.com/a.js?token=TOPSECRET";</script>' }), {}],
      ["wss external URL", buildValidPanelHtml({ scriptBlock: '<script>const ws="wss://evil.example.com/sock";</script>' }), {}],
      ["protocol-relative URL", buildValidPanelHtml({ bodyTag: '<body style="background:#141311"><img src="//cdn.example.com/x.png">' }), {}],
      ["unquoted protocol-relative URL", buildValidPanelHtml({ bodyTag: '<body style="background:#141311"><img src=//cdn.example.com/x.png>' }), {}],
      ["CSS url(//...)", buildValidPanelHtml({ css: `${TOKENS_CSS}\n.bg{background:url(//cdn.example.com/x.png)}` }), {}],
      ["missing dark html lock", buildValidPanelHtml({ htmlTag: "<html>" }), {}],
      ["missing dark meta lock", buildValidPanelHtml({ metaTag: '<meta name="color-scheme" content="dark light">' }), {}],
      ["commented dark meta lock", buildValidPanelHtml({ metaTag: '<!-- <meta name="color-scheme" content="dark"> -->' }), {}],
      ["missing dark body lock", buildValidPanelHtml({ bodyTag: "<body>" }), {}],
      ["prefers-color-scheme", buildValidPanelHtml({ css: `${TOKENS_CSS}\n@media(prefers-color-scheme:light){body{color:#000}}` }), {}],
      ["opacity:0 keyframe", buildValidPanelHtml({ css: `${TOKENS_CSS}\n@keyframes fade{from{opacity:0}to{opacity:1}}` }), {}],
      ["webkit opacity:0% !important keyframe", buildValidPanelHtml({ css: `${TOKENS_CSS}\n@-webkit-keyframes fade{0%{opacity:0% !important}100%{opacity:1}}` }), {}],
      ["innerHTML assignment", buildValidPanelHtml({ scriptBlock: "<script>el.innerHTML='x';</script>" }), {}],
      ["innerHTML += assignment", buildValidPanelHtml({ scriptBlock: "<script>el.innerHTML+='x';</script>" }), {}],
      ["bracket innerHTML assignment", buildValidPanelHtml({ scriptBlock: `<script>el["innerHTML"]='x';</script>` }), {}],
      ["outerHTML assignment", buildValidPanelHtml({ scriptBlock: "<script>el.outerHTML='x';</script>" }), {}],
      ["insertAdjacentHTML sink", buildValidPanelHtml({ scriptBlock: "<script>el.insertAdjacentHTML('beforeend','x');</script>" }), {}],
      ["createContextualFragment sink", buildValidPanelHtml({ scriptBlock: "<script>r.createContextualFragment('<p>x</p>');</script>" }), {}],
      ["parseFromString sink", buildValidPanelHtml({ scriptBlock: "<script>p.parseFromString('<p>x</p>','text/html');</script>" }), {}],
      ["top-level return syntax error", buildValidPanelHtml({ scriptBlock: "<script>return 1;</script>" }), {}],
      ["--buncss-* leakage", buildValidPanelHtml({ css: `${TOKENS_CSS}\n.x{--buncss-foo:1}` }), {}],
      ["wrong light --ok color", buildValidPanelHtml({ css: TOKENS_CSS.replace("#2F7D53", "#3D8B60") }), {}],
      ["missing family token", buildValidPanelHtml({ css: TOKENS_CSS.replace("--s0: #EAE5DC;", "") }), {}],
      ["commented-out family token", buildValidPanelHtml({ css: TOKENS_CSS.replace("--s0: #EAE5DC;", "/* --s0: #EAE5DC; */") }), {}],
      ["missing reduced motion", buildValidPanelHtml({ css: TOKENS_CSS.replace(/prefers-reduced-motion/g, "x-motion") }), {}],
      ["commented-out reduced motion", buildValidPanelHtml({ css: TOKENS_CSS.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*$/i, "/* @media (prefers-reduced-motion: reduce) {} */") }), {}],
    ];

    for (const [label, html, opts] of cases) {
      const res = checkPanelInvariants(html, opts);
      assert.equal(res.ok, false, `expected guard failure for: ${label}`);
      if (label === "external URL") {
        assert.equal(res.errors.join(" ").includes("TOPSECRET"), false, "URL query secrets must be redacted");
        assert.equal(res.errors.join(" ").includes("user:secret"), false, "URL userinfo must be redacted");
      }
      assert.throws(() => assertPanelInvariants(html, opts), /Panel invariant gate failed/, label);
    }

    // CLI unknown --* flags must fail closed with exit code 2
    const guardPath = path.join(REPO_ROOT, "panel", "guard.mjs");
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [guardPath, "--unknown-flag", "dummy.html"], { stdio: "pipe" });
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 2, "guard.mjs CLI must exit 2 on unknown --* flags");
  });
});

describe("agy-mcp-kit Sync & Drift Tooling (scripts/sync-kit.sh)", () => {
  it("syncs kit files with MIT LICENSE, merges selective syncs, protects local edits, and rejects path traversal/symlinks", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kit-sync-test-"));
    try {
      const syncScript = path.join(REPO_ROOT, "scripts", "sync-kit.sh");

      // Manifest self-check must pass
      execFileSync("bash", [syncScript, "--check-manifest"], { cwd: REPO_ROOT, stdio: "pipe" });

      // Sync selected files into temp target repo (MIT LICENSE auto-included)
      execFileSync(
        "bash",
        [syncScript, "--files", "src/test_guard.rs,panel/tokens.css,panel/guard.mjs", tmpRepo],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );

      assert.ok(fs.existsSync(path.join(tmpRepo, ".agy-kit-sync.json")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "src/kit/test_guard.rs")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "panel/kit/tokens.css")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "panel/kit/guard.mjs")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "THIRD_PARTY_LICENSES/agy-mcp-kit-LICENSE")));

      // Selective re-sync of 1 file MUST merge (preserve previously tracked files in .agy-kit-sync.json)
      execFileSync(
        "bash",
        [syncScript, "--files", "src/test_guard.rs", tmpRepo],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );
      const syncMeta = JSON.parse(fs.readFileSync(path.join(tmpRepo, ".agy-kit-sync.json"), "utf8"));
      assert.ok(syncMeta.files["panel/kit/tokens.css"], "selective sync must keep previously tracked files");

      // P2-1: Passing --map against an existing selective .agy-kit-sync.json must preserve subset (not expand to all 10 files)
      execFileSync(
        "bash",
        [syncScript, "--map", "panel/guard.mjs=panel/custom-guard.mjs", tmpRepo],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );
      const mappedMeta = JSON.parse(fs.readFileSync(path.join(tmpRepo, ".agy-kit-sync.json"), "utf8"));
      assert.equal(Object.keys(mappedMeta.files).length, 4, "--map must preserve selective subset count");
      assert.ok(mappedMeta.files["panel/custom-guard.mjs"]);
      assert.equal(mappedMeta.files["src/kit/mcp_protocol.rs"], undefined);

      // P2-1: Reject case-colliding APFS destinations
      assert.throws(
        () =>
          execFileSync(
            "bash",
            [
              syncScript,
              "--files",
              "panel/tokens.css,panel/guard.mjs",
              "--map",
              "panel/tokens.css=panel/kit/item.txt",
              "--map",
              "panel/guard.mjs=panel/kit/ITEM.txt",
              tmpRepo,
            ],
            { cwd: REPO_ROOT, stdio: "pipe" }
          ),
        /Command failed/
      );

      // Zero-drift check passes
      execFileSync("bash", [syncScript, "--check", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" });

      // Mutate a synced file -> --check MUST fail, and sync without --force MUST refuse overwrite
      fs.appendFileSync(path.join(tmpRepo, "panel/kit/tokens.css"), "\n/* local drift */\n");
      assert.throws(
        () => execFileSync("bash", [syncScript, "--check", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" }),
        /Command failed/
      );
      assert.throws(
        () => execFileSync("bash", [syncScript, "--files", "panel/tokens.css", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" }),
        /Command failed/
      );
      // --force explicitly overwrites local edits cleanly
      execFileSync("bash", [syncScript, "--force", "--files", "panel/tokens.css", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" });
      execFileSync("bash", [syncScript, "--check", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" });

      // P0: Reject path traversal via --map and via poisoned .agy-kit-sync.json
      assert.throws(
        () =>
          execFileSync(
            "bash",
            [syncScript, "--files", "src/test_guard.rs", "--map", "src/test_guard.rs=../escape.rs", tmpRepo],
            { cwd: REPO_ROOT, stdio: "pipe" }
          ),
        /Command failed/
      );
      assert.throws(
        () =>
          execFileSync(
            "bash",
            [syncScript, "--files", "src/test_guard.rs", "--map", "src/test_guard.rs=.git/hooks/pre-commit", tmpRepo],
            { cwd: REPO_ROOT, stdio: "pipe" }
          ),
        /Command failed/
      );

      // P0: Reject symlinked destination
      const outside = path.join(os.tmpdir(), `agy-kit-outside-${process.pid}.txt`);
      fs.writeFileSync(outside, "do-not-touch\n");
      try {
        fs.symlinkSync(outside, path.join(tmpRepo, "evil-link.rs"));
        assert.throws(
          () =>
            execFileSync(
              "bash",
              [syncScript, "--force", "--files", "src/test_guard.rs", "--map", "src/test_guard.rs=evil-link.rs", tmpRepo],
              { cwd: REPO_ROOT, stdio: "pipe" }
            ),
          /Command failed/
        );
        assert.equal(fs.readFileSync(outside, "utf8"), "do-not-touch\n");
      } finally {
        fs.rmSync(outside, { force: true });
      }
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("check_sanitized.sh scans working tree and staged index, redacts secrets, and fails closed", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kit-sanitize-test-"));
    try {
      const syncScript = path.join(REPO_ROOT, "scripts", "sync-kit.sh");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmpRepo });
      execFileSync(
        "bash",
        [syncScript, "--files", "scripts/check_sanitized.sh,.github/sanitize-patterns.txt", tmpRepo],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );
      execFileSync("git", ["add", "."], { cwd: tmpRepo });
      execFileSync("bash", ["scripts/check_sanitized.sh"], { cwd: tmpRepo, stdio: "pipe" });

      // Inject a synthetic token pattern into staged index ONLY (then clear working tree copy)
      const fakeSecret = ["ghp", "_"].join("") + "9".repeat(36);
      fs.writeFileSync(path.join(tmpRepo, "leak.txt"), `token=${fakeSecret}\n`);
      execFileSync("git", ["add", "leak.txt"], { cwd: tmpRepo });
      fs.writeFileSync(path.join(tmpRepo, "leak.txt"), "clean-in-worktree\n");

      let stderr = "";
      let failed = false;
      try {
        execFileSync("bash", ["scripts/check_sanitized.sh"], { cwd: tmpRepo, stdio: "pipe" });
      } catch (err) {
        failed = true;
        stderr = String(err.stderr || "") + String(err.stdout || "");
      }
      assert.equal(failed, true, "check_sanitized.sh must catch staged-only secret");
      assert.ok(stderr.includes("leak.txt:1"), "must report file:line");
      assert.equal(stderr.includes(fakeSecret), false, "must NEVER echo secret content");

      // P2-3: Catches expanded /Users/<user>/Code path AND handles filenames containing colons cleanly
      execFileSync("git", ["rm", "-qf", "leak.txt"], { cwd: tmpRepo });
      const fakeLocalPath = ["/", "Users", "/alice/", "Code", "/secret-project"].join("");
      fs.writeFileSync(path.join(tmpRepo, "a:b.txt"), `root=${fakeLocalPath}\n`);
      execFileSync("git", ["add", "a:b.txt"], { cwd: tmpRepo });
      let colonErr = "";
      let colonFailed = false;
      try {
        execFileSync("bash", ["scripts/check_sanitized.sh"], { cwd: tmpRepo, stdio: "pipe" });
      } catch (err) {
        colonFailed = true;
        colonErr = String(err.stderr || "") + String(err.stdout || "");
      }
      assert.equal(colonFailed, true, "check_sanitized.sh must catch /Users/<user>/Code path");
      assert.ok(colonErr.includes("a:b.txt:1"), "must report full filename with colon + line number");

      // Missing patterns file -> fails closed with exit code 2
      fs.rmSync(path.join(tmpRepo, ".github/sanitize-patterns.txt"));
      assert.throws(
        () => execFileSync("bash", ["scripts/check_sanitized.sh"], { cwd: tmpRepo, stdio: "pipe" }),
        /Command failed/
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
