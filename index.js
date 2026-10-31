/*!
 * bundle-leak-check — fail the build when your JavaScript bundle contains
 * something it must not ship: a secret, an internal hostname, an admin
 * endpoint, a debug flag, a global you thought was tree-shaken away.
 *
 * Zero dependencies. Node 18+.
 *
 * The case that motivated it: a public widget imported three display helpers
 * from an internal API client. That client's last line was a top-level
 * `window.PaidApi = api`. A top-level side effect defeats tree-shaking, so the
 * bundler kept the whole module — and every page running the public widget was
 * silently installing a working, authenticated client for a *paid* API into
 * global scope, where any script on the page could spend the owner's money.
 *
 * Nothing caught it. The build succeeded, the bundle worked, the tests passed.
 * It was found by reading minified output by hand, months later.
 *
 * MIT licensed.
 */

import { readFile } from 'node:fs/promises';

/**
 * Patterns that are a leak in essentially any public bundle. Each is
 * deliberately narrow: a rule that cries wolf gets switched off, and a rule
 * that is switched off catches nothing.
 */
export const BUILTIN_RULES = [
  { id: 'aws-access-key-id',  re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                    hint: 'AWS access key id' },
  { id: 'github-token',       re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                   hint: 'GitHub token' },
  { id: 'slack-token',        re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,                 hint: 'Slack token' },
  { id: 'stripe-secret-key',  re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,         hint: 'Stripe secret key' },
  { id: 'google-api-key',     re: /\bAIza[0-9A-Za-z_-]{35}\b/g,                        hint: 'Google API key' },
  { id: 'openai-key',         re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,              hint: 'OpenAI-style secret key' },
  { id: 'private-key-block',  re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, hint: 'private key block' },
  { id: 'jwt',                re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, hint: 'JWT' },
  { id: 'basic-auth-url',     re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/gi,    hint: 'credentials embedded in a URL' },
  { id: 'private-host',       re: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.(?:local|internal|test|localdomain))\b/gi, hint: 'private or local hostname' },
  { id: 'source-map-ref',     re: /\/\/[#@]\s*sourceMappingURL=(?!data:)/g,            hint: 'source map reference' },
];

const DEFAULT_IGNORE = [/\bAKIAIOSFODNN7EXAMPLE\b/, /\bexample\.com\b/];

/**
 * Scan text for rule hits.
 *
 * @param {string} text
 * @param {object} [opt]
 * @param {string[]} [opt.forbid]      literal strings that must not appear
 * @param {RegExp[]} [opt.forbidPattern]
 * @param {string[]} [opt.allow]       rule ids (or literals) to skip
 * @param {boolean}  [opt.builtins=true]
 * @param {RegExp[]} [opt.ignore]      lines/snippets to treat as deliberate
 * @param {number}   [opt.context=48]  characters of context per finding
 * @returns {{id:string,hint:string,match:string,index:number,line:number,context:string}[]}
 */
export function scanText(text, opt = {}) {
  const {
    forbid = [],
    forbidPattern = [],
    allow = [],
    builtins = true,
    ignore = [],
    context = 48,
  } = opt;

  const allowed = new Set(allow);
  const ignores = [...DEFAULT_IGNORE, ...ignore];
  const findings = [];

  const rules = [
    ...(builtins ? BUILTIN_RULES.filter((r) => !allowed.has(r.id)) : []),
    ...forbid
      .filter((s) => s && !allowed.has(s))
      .map((s) => ({ id: `forbid:${s}`, re: new RegExp(escapeRe(s), 'g'), hint: `forbidden string "${s}"` })),
    ...forbidPattern.map((re, i) => ({
      id: `pattern:${i}`,
      re: new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
      hint: `forbidden pattern ${re}`,
    })),
  ];

  // Line starts, so a finding can report a line number without splitting the
  // whole file per match. A minified bundle is one line; that is still useful.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);

  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const at = m.index;
      const snippet = text.slice(Math.max(0, at - context), at + m[0].length + context);
      if (ignores.some((re) => re.test(snippet))) continue;
      findings.push({
        id: rule.id,
        hint: rule.hint,
        match: redact(m[0]),
        index: at,
        line: upperBound(lineStarts, at),
        context: redact(snippet).replace(/\s+/g, ' ').trim(),
      });
      if (m[0].length === 0) rule.re.lastIndex += 1;   // never spin on an empty match
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}

/** Scan files. Returns a report; never throws on a missing file. */
export async function scanFiles(paths, opt = {}) {
  const files = [];
  for (const path of paths) {
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (err) { files.push({ path, error: err.message, findings: [] }); continue; }
    files.push({ path, bytes: text.length, findings: scanText(text, opt) });
  }
  const total = files.reduce((n, f) => n + f.findings.length, 0);
  const errors = files.filter((f) => f.error).length;
  return { files, total, errors, ok: total === 0 && errors === 0 };
}

/**
 * Never print a secret in full — CI logs are searchable, and often public.
 * Enough to identify it, not enough to use it.
 */
function redact(s) {
  return String(s).replace(
    /\b([A-Za-z0-9_-]{12,})\b/g,
    (w) => (w.length <= 12 ? w : `${w.slice(0, 4)}…${w.slice(-2)}[${w.length}]`),
  );
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function upperBound(starts, index) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans + 1;
}

export default scanFiles;
