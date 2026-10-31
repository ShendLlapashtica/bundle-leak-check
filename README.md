# bundle-leak-check

**Fail the build when your JavaScript bundle ships something it must not.**

A secret. An internal hostname. An admin endpoint. A source map pointing at
your unminified source. Or a global you were certain the bundler had
tree-shaken away.

```bash
npx bundle-leak-check 'dist/**/*.js'
```

Exit code `1` if anything is found, `0` if clean. Put it in CI and stop
thinking about it.

- **Zero dependencies.** Two files, Node 18+.
- **Never prints a secret in full.** CI logs are searchable, and often public.
- **11 built-in rules**, deliberately narrow, plus your own literals and regexes.
- **17 tests.**

---

## The bug that caused this

A public widget imported three display helpers — price formatting, image URL
building, localisation — from an internal API client module.

That module's last line was:

```js
window.PaidApi = api;
```

A top-level side effect defeats tree-shaking. So the bundler kept the entire
module, and **every page running the public widget silently installed a
working, authenticated client for a paid API into global scope** — where any
script on that page could have spent the owner's money.

Nothing caught it. The build succeeded. The bundle worked. The tests passed. It
was found by reading minified output by hand, months later.

```bash
bundle-leak-check dist/widget.js --forbid PaidApi --forbid x-api-key
```

```
✗ dist/widget.js — 1 finding(s)
    line 1  [forbid:PaidApi] forbidden string "PaidApi"
      PaidApi
      …var a=1;window.PaidApi=api;export{a};…

FAILED: 1 finding(s) across 1 file(s)
```

That is the real value of this tool: **asserting the absence of your own
strings.** Secret detection is table stakes and other tools do it. Nobody can
guess that *your* bundle must never contain `PaidApi`, your internal hostname,
or your auth header's name. You have to say so — and then have a build that
fails when it stops being true.

---

## Usage

```bash
bundle-leak-check <files...> [options]

  --forbid <string>      a literal that must not appear (repeatable)
  --forbid-pattern <re>  a regex that must not match (repeatable)
  --allow <id|string>    skip a rule id or a forbidden literal (repeatable)
  --no-builtins          only check what you specified
  --json                 machine-readable output
  --quiet                print nothing, just set the exit code
```

Globs are expanded, so **quote them**: `'dist/**/*.js'`

Exit codes: `0` clean · `1` findings · `2` bad usage or an unreadable file.

### In CI

```yaml
# .github/workflows/ci.yml
- run: npm run build
- run: npx bundle-leak-check 'dist/**/*.js'
         --forbid api.internal.example.com
         --forbid x-internal-token
         --allow source-map-ref
```

### As a library

```js
import { scanText, scanFiles } from 'bundle-leak-check';

const report = await scanFiles(['dist/app.js'], {
  forbid: ['PaidApi', 'admin.internal'],
  allow: ['source-map-ref'],
});

if (!report.ok) {
  for (const f of report.files)
    for (const x of f.findings)
      console.error(`${f.path}:${x.line} [${x.id}] ${x.hint}`);
  process.exit(1);
}
```

Findings are `{ id, hint, match, index, line, context }`, sorted by position.

---

## Built-in rules

| id | catches |
|---|---|
| `aws-access-key-id` | `AKIA…` / `ASIA…` |
| `github-token` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` |
| `slack-token` | `xoxb-` `xoxa-` `xoxp-` `xoxr-` `xoxs-` |
| `stripe-secret-key` | `sk_live_` `sk_test_` `rk_live_` `rk_test_` |
| `google-api-key` | `AIza…` |
| `openai-key` | `sk-…` / `sk-proj-…` |
| `private-key-block` | `-----BEGIN … PRIVATE KEY-----` |
| `jwt` | three base64url segments starting `eyJ` |
| `basic-auth-url` | `https://user:pass@host` |
| `private-host` | `localhost`, `127.0.0.1`, RFC1918 ranges, `*.local`, `*.internal`, `*.test` |
| `source-map-ref` | `//# sourceMappingURL=` (not inlined `data:`) |

Silence any of them with `--allow <id>`. Turn the lot off with
`--no-builtins`.

Each rule is deliberately **narrow**. A rule that cries wolf gets switched off,
and a rule that is switched off catches nothing. `AKIAIOSFODNN7EXAMPLE` (AWS's
own documentation key) and `example.com` are ignored by default.

---

## Secrets are redacted in output

```
line 1  [aws-access-key-id] AWS access key id
  AKIA…UV[20]
```

Enough to identify which secret leaked. Not enough to use it. This applies to
the surrounding context line too, so pasting CI output into a ticket is safe.

---

## What this is not

- **Not a git history scanner.** It reads built output. For history, use
  `gitleaks` or `trufflehog`.
- **Not entropy-based.** It matches known shapes and your declared strings, so
  it has very few false positives — and it will miss a high-entropy secret in
  a format it does not know. Declare that one with `--forbid`.
- **Not a replacement for not having the secret there.** If a key is in your
  client bundle it is public the moment you ship, and rotating it is the fix.
  This tool tells you to rotate it *before* you ship.

---

## Tests

```bash
npm test     # node --test, 17 tests, no dependencies
```

Covered: each secret shape, redaction (asserting the full secret never appears
in output), public hostnames not being flagged, inlined source maps not being
flagged, forbidden literals being regex-escaped (`a.c` must not match `abc`),
a non-global user regex being forced global so `exec` cannot loop forever,
allow-listing by id, line numbers in both multi-line and one-line minified
bundles, findings ordered by position, a missing file reporting rather than
throwing, and every built-in rule having a unique id and a global flag.

---

MIT © Shend Llapashtica
