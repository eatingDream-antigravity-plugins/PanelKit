#!/usr/bin/env node
// Shared executable Panel QA Gate enforcing Editorial-Warm §0/§1/§6 and i18n parity invariants.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const DEFAULT_MAX_BYTES = 43_500;
export const WARN_BYTES = 44_000;
export const HARD_MAX_BYTES = 46_080;

const CJK_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/g;
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_.-]+)\}/g;

export const FAMILY_TOKENS = Object.freeze([
  "--bg", "--s1", "--s2", "--s0",
  "--t1", "--t2", "--t3",
  "--ln", "--l2", "--sh",
  "--ac", "--ah", "--ok", "--wn", "--er", "--in",
]);

function extractAllCssBlocks(css, selectorRegex) {
  const blocks = [];
  for (const m of css.matchAll(selectorRegex)) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks.length > 0 ? blocks.join("\n") : null;
}

function redactUrlForLog(rawUrl) {
  try {
    const u = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/)[0].replace(/\/\/[^/@]+@/, "//[redacted]@");
  }
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

  // Strip HTML comments before structural tag scanning so commented-out <meta>/<style>/<script> cannot spoof checks.
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, "");

  // CSP must be declared inside <head> via <meta http-equiv="Content-Security-Policy" ...>
  const headMatch = htmlNoComments.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headHtml = headMatch ? headMatch[1] : "";
  const cspMetaTags =
    headHtml.match(/<meta\b[^>]*http-equiv\s*=\s*(?:["']content-security-policy["']|content-security-policy(?=[\s/>]))[^>]*>/gi) ||
    [];
  const hasValidCsp = cspMetaTags.some((tag) => {
    const cm = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!cm) return false;
    return /(?:^|;)\s*default-src\s+'none'\s*(?:;|$)/i.test(cm[2]);
  });
  if (!hasValidCsp) {
    errors.push("missing <head> CSP meta directive: default-src 'none'");
  }

  // Zero external URLs (allow standard XML SVG namespace only; redact query/userinfo in errors)
  const strippedSvgNs = html.replace(/http:\/\/www\.w3\.org\/2000\/svg/gi, "");
  const extUrl = strippedSvgNs.match(/(?:https?|wss?):\/\/[^"'\s<>)]+/i);
  if (extUrl) {
    errors.push(`forbidden external URL detected: ${redactUrlForLog(extUrl[0])}`);
  }
  const protoRelAttr = strippedSvgNs.match(
    /\b(?:src|href|action|poster|data)\s*=\s*(?:["'](\/\/[^"'\s<>]+)["']|(\/\/[^\s"'<>`]+))/i
  );
  if (protoRelAttr) {
    errors.push(`forbidden protocol-relative URL detected: ${redactUrlForLog(protoRelAttr[1] || protoRelAttr[2])}`);
  }
  const protoRelCssUrl = strippedSvgNs.match(/\burl\(\s*["']?(\/\/[^"'\s)]+)/i);
  if (protoRelCssUrl) {
    errors.push(`forbidden protocol-relative CSS url() detected: ${redactUrlForLog(protoRelCssUrl[1])}`);
  }
  const protoRelImport = strippedSvgNs.match(/@import\s+["'](\/\/[^"'\s]+)["']/i);
  if (protoRelImport) {
    errors.push(`forbidden protocol-relative @import detected: ${redactUrlForLog(protoRelImport[1])}`);
  }
  const protoRelQuotedHost = strippedSvgNs.match(
    /["'](\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^"'\s<>]*)?)["']/i
  );
  if (protoRelQuotedHost) {
    errors.push(`forbidden protocol-relative URL string detected: ${redactUrlForLog(protoRelQuotedHost[1])}`);
  }

  // Dark-first Frame-0 locks
  const htmlTag = htmlNoComments.match(/<html\b[^>]*>/i)?.[0] || "";
  if (
    !/style=(["'])[\s\S]*?background\s*:\s*#141311[\s\S]*?\1/i.test(htmlTag) ||
    !/style=(["'])[\s\S]*?color-scheme\s*:\s*dark[\s\S]*?\1/i.test(htmlTag)
  ) {
    errors.push('missing dark-first inline lock on <html> (background:#141311;color-scheme:dark)');
  }
  if (
    !/<meta\b[^>]*name=["']color-scheme["'][^>]*content=["']dark["'][^>]*>/i.test(htmlNoComments) &&
    !/<meta\b[^>]*content=["']dark["'][^>]*name=["']color-scheme["'][^>]*>/i.test(htmlNoComments)
  ) {
    errors.push('missing dark-only <meta name="color-scheme" content="dark">');
  }
  const bodyTag = htmlNoComments.match(/<body\b[^>]*>/i)?.[0] || "";
  if (!/style=(["'])[\s\S]*?background\s*:\s*#141311[\s\S]*?\1/i.test(bodyTag)) {
    errors.push('missing dark-first inline lock on <body> (background:#141311)');
  }

  // Zero prefers-color-scheme
  if (/prefers-color-scheme/i.test(htmlNoComments)) {
    errors.push("forbidden prefers-color-scheme query found");
  }

  // Extract all <style> blocks and strip CSS comments once for keyframes & token checks
  const styleBlocks = [...htmlNoComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const combinedCss = styleBlocks.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

  // Zero opacity:0 / 0% / 0 !important inside @keyframes / @-webkit-keyframes
  const keyframes =
    combinedCss.match(/@(?:-webkit-)?keyframes\s+[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi) || [];
  for (const kf of keyframes) {
    if (/opacity\s*:\s*(?:0(?:\.0+)?|\.0+)%?(?:\s*!important)?(?:\s*[;}]|$)/i.test(kf)) {
      errors.push(`forbidden opacity:0 in @keyframes: ${kf.slice(0, 80)}`);
    }
  }

  // Zero innerHTML / outerHTML (= or +=, dot or bracket) / insertAdjacentHTML / document.write / createContextualFragment / parseFromString DOM sinks
  if (/(?:\.(?:innerHTML|outerHTML)|\[\s*["'`](?:innerHTML|outerHTML)["'`]\s*\])\s*\+?=/i.test(html)) {
    errors.push("forbidden innerHTML/outerHTML assignment detected");
  }
  if (
    /(?:\.(?:insertAdjacentHTML|write|writeln|createContextualFragment|parseFromString)|\[\s*["'`](?:insertAdjacentHTML|write|writeln|createContextualFragment|parseFromString)["'`]\s*\])\s*\(/i.test(
      html
    )
  ) {
    errors.push(
      "forbidden HTML string injection sink detected (insertAdjacentHTML/document.write/createContextualFragment/parseFromString)"
    );
  }

  // Zero --buncss-* declarations
  if (/--buncss-/i.test(htmlNoComments)) {
    errors.push("forbidden --buncss-* declaration detected");
  }

  // Exactly one inline <script>
  const scripts = htmlNoComments.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
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
        // Parse-only top-level script validation without executing the script body.
        new vm.Script(jsBody);
      } catch (err) {
        errors.push(`inline <script> syntax error: ${err.message}`);
      }
    }
  }

  // All 16 family tokens in BOTH dark (:root) and light (:root[data-theme="light"]) + light --ok: #2F7D53
  if (styleBlocks.length === 0) {
    errors.push("missing inline <style> block");
  } else {
    const darkBlock = extractAllCssBlocks(combinedCss, /:root\s*\{([^}]+)\}/gi);
    const lightBlock = extractAllCssBlocks(
      combinedCss,
      /:root\s*\[\s*data-theme\s*=\s*["']?light["']?\s*\]\s*\{([^}]+)\}/gi
    );

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
    if (!/prefers-reduced-motion\s*:\s*reduce/i.test(combinedCss)) {
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

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function flattenI18nEntries(input, localeName) {
  const entries = new Map();
  const errors = [];

  if (!(input instanceof Map) && !isPlainObject(input)) {
    errors.push(
      `Invalid ${localeName} translation map: expected a plain { key: string } object or Map (e.g., I18N.${localeName}).`
    );
    return { entries, errors };
  }

  const walk = (node, prefix) => {
    const iter = node instanceof Map ? node.entries() : Object.entries(node);
    for (const [rawKey, val] of iter) {
      const key = String(rawKey);
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof val === "string") {
        entries.set(fullKey, val);
      } else if (val instanceof Map || isPlainObject(val)) {
        walk(val, fullKey);
      } else {
        const kind = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
        errors.push(
          `Invalid ${localeName} value at "${fullKey}": expected string (got ${kind}) — replace with a string or nested object.`
        );
      }
    }
  };

  walk(input, "");
  return { entries, errors };
}

function extractPlaceholders(str) {
  const counts = new Map();
  for (const m of str.matchAll(PLACEHOLDER_RE)) {
    const token = `{${m[1]}}`;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function formatPlaceholders(counts) {
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tok, n]) => (n > 1 ? `${tok} x${n}` : tok))
    .join(", ");
}

function placeholderCountsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

function previewText(str, maxLen = 48) {
  const compact = str.replace(/\s+/g, " ").trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
}

/**
 * Verifies 1:1 key and `{placeholder}` parity between `enMap` and `zhMap`.
 * Returns `{ ok, checkedKeys, warnings, errors }` with actionable remediation errors.
 */
export function checkI18nParity(enMap, zhMap) {
  const warnings = [];
  const enParsed = flattenI18nEntries(enMap, "en");
  const zhParsed = flattenI18nEntries(zhMap, "zh");
  const errors = [...enParsed.errors, ...zhParsed.errors];

  for (const [key, enVal] of enParsed.entries) {
    if (!zhParsed.entries.has(key)) {
      errors.push(
        `Missing zh translation for key "${key}" (en: "${previewText(enVal)}") — add "${key}" to your zh dictionary to restore 1:1 parity.`
      );
      continue;
    }
    const zhVal = zhParsed.entries.get(key);
    const enEmpty = enVal.trim().length === 0;
    const zhEmpty = zhVal.trim().length === 0;
    if (enEmpty !== zhEmpty) {
      const emptyLocale = zhEmpty ? "zh" : "en";
      const nonEmptyVal = zhEmpty ? enVal : zhVal;
      errors.push(
        `Empty ${emptyLocale} translation for key "${key}" (other locale: "${previewText(nonEmptyVal)}") — provide translated copy instead of an empty string.`
      );
      continue;
    }
    const enPh = extractPlaceholders(enVal);
    const zhPh = extractPlaceholders(zhVal);
    if (!placeholderCountsEqual(enPh, zhPh)) {
      errors.push(
        `Placeholder mismatch for i18n key "${key}": en uses [${formatPlaceholders(enPh)}] but zh uses [${formatPlaceholders(zhPh)}] — keep identical {placeholder} tokens in both locales.`
      );
    }
  }

  for (const key of zhParsed.entries.keys()) {
    if (!enParsed.entries.has(key)) {
      errors.push(
        `Extra zh translation key "${key}" missing from en — add "${key}" to your en dictionary or remove the stale zh key.`
      );
    }
  }

  return { ok: errors.length === 0, checkedKeys: enParsed.entries.size, warnings, errors };
}

/**
 * Throws an Error listing every i18n parity violation if `enMap` and `zhMap` diverge.
 */
export function assertI18nParity(enMap, zhMap) {
  const report = checkI18nParity(enMap, zhMap);
  if (!report.ok) {
    throw new Error(`i18n parity gate failed (${report.checkedKeys} keys):\n- ${report.errors.join("\n- ")}`);
  }
  return report;
}

/**
 * Flags stray CJK characters or CJK punctuation in English UI copy (`enMap`).
 * Pass `{ allowKeys: ["langZh"] }` if specific keys intentionally render localized language labels.
 */
export function checkEnNoCjk(enMap, options = {}) {
  const warnings = [];
  const allowKeys = new Set(Array.isArray(options.allowKeys) || options.allowKeys instanceof Set ? options.allowKeys : []);
  const parsed = flattenI18nEntries(enMap, "en");
  const errors = [...parsed.errors];

  for (const [key, val] of parsed.entries) {
    if (allowKeys.has(key)) continue;
    const matches = val.match(CJK_CHAR_RE);
    if (matches && matches.length > 0) {
      const uniqueChars = [...new Set(matches)].slice(0, 6).join("");
      errors.push(
        `Stray CJK character(s) [${uniqueChars}] in EN copy for key "${key}": "${previewText(val)}" — replace with English copy (or pass "${key}" in options.allowKeys if intentionally localized).`
      );
    }
  }

  return { ok: errors.length === 0, checkedKeys: parsed.entries.size, warnings, errors };
}

/**
 * Throws an Error if English UI copy contains unexpected CJK characters.
 */
export function assertEnNoCjk(enMap, options = {}) {
  const report = checkEnNoCjk(enMap, options);
  if (!report.ok) {
    throw new Error(`EN no-CJK gate failed (${report.checkedKeys} keys):\n- ${report.errors.join("\n- ")}`);
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
    if (args[i] === "--max-bytes") {
      if (!args[i + 1]) {
        console.error("Error: --max-bytes requires a positive integer value");
        process.exit(2);
      }
      const parsed = Number(args[i + 1]);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error(`Error: invalid --max-bytes value: ${args[i + 1]}`);
        process.exit(2);
      }
      maxBytes = parsed;
      i += 1;
    } else if (args[i].startsWith("-")) {
      console.error(`Error: unknown option: ${args[i]}`);
      process.exit(2);
    } else {
      if (filePath !== null) {
        console.error(`Error: unexpected extra argument: ${args[i]}`);
        process.exit(2);
      }
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
