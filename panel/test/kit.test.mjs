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
    app.close();
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
  });

  it("rejects every single invariant violation cleanly", () => {
    const cases = [
      ["byte budget exceeded", buildValidPanelHtml(), { maxBytes: 100 }],
      ["multiple scripts", buildValidPanelHtml({ scriptBlock: "<script>1</script><script>2</script>" }), {}],
      ["missing CSP", buildValidPanelHtml({ cspTag: "" }), {}],
      ["external URL", buildValidPanelHtml({ scriptBlock: '<script>const u="https://cdn.example.com/a.js";</script>' }), {}],
      ["missing dark html lock", buildValidPanelHtml({ htmlTag: "<html>" }), {}],
      ["missing dark meta lock", buildValidPanelHtml({ metaTag: '<meta name="color-scheme" content="dark light">' }), {}],
      ["missing dark body lock", buildValidPanelHtml({ bodyTag: "<body>" }), {}],
      ["prefers-color-scheme", buildValidPanelHtml({ css: `${TOKENS_CSS}\n@media(prefers-color-scheme:light){body{color:#000}}` }), {}],
      ["opacity:0 keyframe", buildValidPanelHtml({ css: `${TOKENS_CSS}\n@keyframes fade{from{opacity:0}to{opacity:1}}` }), {}],
      ["innerHTML assignment", buildValidPanelHtml({ scriptBlock: "<script>el.innerHTML='x';</script>" }), {}],
      ["outerHTML assignment", buildValidPanelHtml({ scriptBlock: "<script>el.outerHTML='x';</script>" }), {}],
      ["--buncss-* leakage", buildValidPanelHtml({ css: `${TOKENS_CSS}\n.x{--buncss-foo:1}` }), {}],
      ["wrong light --ok color", buildValidPanelHtml({ css: TOKENS_CSS.replace("#2F7D53", "#3D8B60") }), {}],
      ["missing family token", buildValidPanelHtml({ css: TOKENS_CSS.replace("--s0: #EAE5DC;", "") }), {}],
      ["missing reduced motion", buildValidPanelHtml({ css: TOKENS_CSS.replace(/prefers-reduced-motion/g, "x-motion") }), {}],
    ];

    for (const [label, html, opts] of cases) {
      const res = checkPanelInvariants(html, opts);
      assert.equal(res.ok, false, `expected guard failure for: ${label}`);
      assert.throws(() => assertPanelInvariants(html, opts), /Panel invariant gate failed/, label);
    }
  });
});

describe("agy-mcp-kit Sync & Drift Tooling (scripts/sync-kit.sh)", () => {
  it("syncs kit files, passes --check on zero drift, and fails --check when modified", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kit-sync-test-"));
    try {
      const syncScript = path.join(REPO_ROOT, "scripts", "sync-kit.sh");

      // Manifest self-check must pass
      execFileSync("bash", [syncScript, "--check-manifest"], { cwd: REPO_ROOT, stdio: "pipe" });

      // Sync selected files into temp target repo
      execFileSync(
        "bash",
        [syncScript, "--files", "src/test_guard.rs,panel/tokens.css,panel/guard.mjs", tmpRepo],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );

      assert.ok(fs.existsSync(path.join(tmpRepo, ".agy-kit-sync.json")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "src/kit/test_guard.rs")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "panel/kit/tokens.css")));
      assert.ok(fs.existsSync(path.join(tmpRepo, "panel/kit/guard.mjs")));

      // Zero-drift check passes
      execFileSync("bash", [syncScript, "--check", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" });

      // Mutate a synced file -> --check MUST fail non-zero
      fs.appendFileSync(path.join(tmpRepo, "panel/kit/tokens.css"), "\n/* local drift */\n");
      assert.throws(
        () => execFileSync("bash", [syncScript, "--check", tmpRepo], { cwd: REPO_ROOT, stdio: "pipe" }),
        /Command failed/
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("check_sanitized.sh redacts secret contents and fails closed on errors", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kit-sanitize-test-"));
    try {
      const syncScript = path.join(REPO_ROOT, "scripts", "sync-kit.sh");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmpRepo });
      execFileSync("git", ["config", "user.name", "test"], { cwd: tmpRepo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
      execFileSync(
        "bash",
        [syncScript, "--files", "scripts/check_sanitized.sh,.github/sanitize-patterns.txt", tmpRepo],
        { cwd: REPO_ROOT, stdio: "pipe" }
      );
      execFileSync("git", ["add", "."], { cwd: tmpRepo });
      execFileSync("bash", ["scripts/check_sanitized.sh"], { cwd: tmpRepo, stdio: "pipe" });

      // Inject a synthetic token pattern at runtime so this test file itself stays clean
      const fakeSecret = ["ghp", "_"].join("") + "9".repeat(36);
      fs.writeFileSync(path.join(tmpRepo, "leak.txt"), `token=${fakeSecret}\n`);
      execFileSync("git", ["add", "leak.txt"], { cwd: tmpRepo });
      let stderr = "";
      let failed = false;
      try {
        execFileSync("bash", ["scripts/check_sanitized.sh"], { cwd: tmpRepo, stdio: "pipe" });
      } catch (err) {
        failed = true;
        stderr = String(err.stderr || "") + String(err.stdout || "");
      }
      assert.equal(failed, true, "check_sanitized.sh must fail on matched secret");
      assert.ok(stderr.includes("leak.txt:1"), "must report file:line");
      assert.equal(stderr.includes(fakeSecret), false, "must NEVER echo secret content");
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
