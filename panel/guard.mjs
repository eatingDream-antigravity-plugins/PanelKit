#!/usr/bin/env node
// Shared executable Panel QA Gate enforcing Opus 5.5 Editorial-Warm §0/§1/§6 invariants.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_BYTES = 43_500;
export const WARN_BYTES = 44_000;
export const HARD_MAX_BYTES = 46_080;

export const FAMILY_TOKENS = Object.freeze([
  "--bg", "--s1", "--s2", "--s0",
  "--t1", "--t2", "--t3",
  "--ln", "--l2", "--sh",
  "--ac", "--ah", "--ok", "--wn", "--er", "--in",
]);

function extractCssBlock(css, selectorRegex) {
  const m = css.match(selectorRegex);
  return m ? m[1] : null;
}

/**
 * Evaluates all Editorial-Warm panel invariants against a compiled self-contained HTML string.
 * Returns `{ ok, bytes, warnings, errors }`.
 */
export function checkPanelInvariants(html, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const hardMaxBytes = options.hardMaxBytes ?? HARD_MAX_BYTES;
  const warnBytes = options.warnBytes ?? WARN_BYTES;
  const bootPlaceholder = options.bootPlaceholder ?? null;
  const skipJsParse = options.skipJsParse === true;

  const errors = [];
  const warnings = [];

  if (typeof html !== "string" || html.length === 0) {
    return { ok: false, bytes: 0, warnings, errors: ["panel HTML must be a non-empty string"] };
  }

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes >= hardMaxBytes) {
    errors.push(`hard size gate exceeded: ${bytes} B >= ${hardMaxBytes} B`);
  }
  if (bytes > maxBytes) {
    errors.push(`size budget exceeded: ${bytes} B > ${maxBytes} B`);
  }
  if (bytes > warnBytes) {
    warnings.push(`panel size warning: ${bytes} B > ${warnBytes} B`);
  }

  // CSP & zero external URLs (allow standard XML SVG namespace only)
  if (!/default-src\s+'none'/i.test(html)) {
    errors.push("missing CSP directive: default-src 'none'");
  }
  const strippedSvgNs = html.replace(/http:\/\/www\.w3\.org\/2000\/svg/gi, "");
  const extUrl = strippedSvgNs.match(/https?:\/\/[^"'\s<>)]+/i);
  if (extUrl) {
    errors.push(`forbidden external URL detected: ${extUrl[0]}`);
  }

  // Dark-first Frame-0 locks
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] || "";
  if (
    !/style=["'][^"']*background\s*:\s*#141311/i.test(htmlTag) ||
    !/style=["'][^"']*color-scheme\s*:\s*dark/i.test(htmlTag)
  ) {
    errors.push('missing dark-first inline lock on <html> (background:#141311;color-scheme:dark)');
  }
  if (!/<meta\b[^>]*name=["']color-scheme["'][^>]*content=["']dark["'][^>]*>/i.test(html) &&
      !/<meta\b[^>]*content=["']dark["'][^>]*name=["']color-scheme["'][^>]*>/i.test(html)) {
    errors.push('missing dark-only <meta name="color-scheme" content="dark">');
  }
  const bodyTag = html.match(/<body\b[^>]*>/i)?.[0] || "";
  if (!/style=["'][^"']*background\s*:\s*#141311/i.test(bodyTag)) {
    errors.push('missing dark-first inline lock on <body> (background:#141311)');
  }

  // Zero prefers-color-scheme
  if (/prefers-color-scheme/i.test(html)) {
    errors.push("forbidden prefers-color-scheme query found");
  }

  // Zero opacity:0 inside @keyframes
  const keyframes = html.match(/@keyframes\s+[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi) || [];
  for (const kf of keyframes) {
    if (/opacity\s*:\s*0(?:\.0+)?(?:\s*[;}]|$)/i.test(kf) || /opacity\s*:\s*\.0+(?:\s*[;}]|$)/i.test(kf)) {
      errors.push(`forbidden opacity:0 in @keyframes: ${kf.slice(0, 80)}`);
    }
  }

  // Zero innerHTML / outerHTML assignments
  if (/\.(?:innerHTML|outerHTML)\s*=/i.test(html)) {
    errors.push("forbidden innerHTML/outerHTML assignment detected");
  }

  // Zero --buncss-* declarations
  if (/--buncss-/i.test(html)) {
    errors.push("forbidden --buncss-* declaration detected");
  }

  // Exactly one inline <script>
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  if (scripts.length !== 1) {
    errors.push(`expected exactly 1 inline <script> tag, found ${scripts.length}`);
  } else {
    const openTag = scripts[0].match(/^<script\b[^>]*>/i)?.[0] || "";
    if (/\bsrc\s*=/i.test(openTag)) {
      errors.push("external <script src=...> is forbidden");
    }
    if (bootPlaceholder && !scripts[0].includes(bootPlaceholder)) {
      errors.push(`missing SSR boot placeholder: ${bootPlaceholder}`);
    }
    if (!skipJsParse) {
      const jsBody = scripts[0].replace(/^<script\b[^>]*>|<\/script>$/gi, "");
      try {
        // Parse-only validation without executing the script body.
        new Function(jsBody);
      } catch (err) {
        errors.push(`inline <script> syntax error: ${err.message}`);
      }
    }
  }

  // All 16 family tokens in BOTH dark (:root) and light (:root[data-theme="light"]) + light --ok: #2F7D53
  const styleMatch = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) {
    errors.push("missing inline <style> block");
  } else {
    const css = styleMatch[1];
    const darkBlock = extractCssBlock(css, /:root\s*\{([^}]+)\}/i);
    const lightBlock = extractCssBlock(css, /:root\s*\[\s*data-theme\s*=\s*["']?light["']?\s*\]\s*\{([^}]+)\}/i);

    if (!darkBlock) {
      errors.push("missing dark :root token block");
    }
    if (!lightBlock) {
      errors.push('missing light :root[data-theme="light"] token block');
    }
    if (darkBlock && lightBlock) {
      for (const tok of FAMILY_TOKENS) {
        const tokRe = new RegExp(`${tok}\\s*:`, "i");
        if (!tokRe.test(darkBlock)) errors.push(`missing dark family token: ${tok}`);
        if (!tokRe.test(lightBlock)) errors.push(`missing light family token: ${tok}`);
      }
      if (!/--ok\s*:\s*#2f7d53\b/i.test(lightBlock)) {
        errors.push("light theme --ok must be #2F7D53");
      }
    }
    if (!/prefers-reduced-motion\s*:\s*reduce/i.test(css)) {
      errors.push("missing @media (prefers-reduced-motion: reduce) rule");
    }
  }

  return { ok: errors.length === 0, bytes, warnings, errors };
}

/**
 * Throws an Error listing every failed invariant if `html` violates the Panel QA gate.
 */
export function assertPanelInvariants(html, options = {}) {
  const report = checkPanelInvariants(html, options);
  if (!report.ok) {
    throw new Error(`Panel invariant gate failed (${report.bytes} B):\n- ${report.errors.join("\n- ")}`);
  }
  return report;
}

// CLI entrypoint: `node panel/guard.mjs <panel.html> [--max-bytes 43500]`
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  let filePath = null;
  let maxBytes = DEFAULT_MAX_BYTES;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--max-bytes" && args[i + 1]) {
      maxBytes = Number(args[i + 1]);
      i += 1;
    } else if (!args[i].startsWith("--")) {
      filePath = args[i];
    }
  }
  if (!filePath) {
    console.error("Usage: node panel/guard.mjs <panel.html> [--max-bytes 43500]");
    process.exit(2);
  }
  const html = fs.readFileSync(filePath, "utf8");
  const report = checkPanelInvariants(html, { maxBytes });
  for (const w of report.warnings) console.warn(`[warn] ${w}`);
  if (!report.ok) {
    console.error(`FAIL ${filePath} (${report.bytes} B):`);
    for (const e of report.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`PASS ${filePath} (${report.bytes} B <= ${maxBytes} B)`);
}
