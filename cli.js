#!/usr/bin/env node
/*! bundle-leak-check CLI — exits 1 when a bundle ships something it must not. */
import { scanFiles } from './index.js';
import { glob } from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const many = (name) => argv.reduce((a, v, i) => (v === `--${name}` ? [...a, argv[i + 1]] : a), []);
const has = (name) => argv.includes(`--${name}`);

if (has('help') || argv.length === 0) {
  console.log(`bundle-leak-check — fail the build when a bundle contains what it must not ship

  bundle-leak-check <files...> [options]

  --forbid <string>     a literal that must not appear (repeatable)
  --allow <id|string>   skip a rule id or a forbidden literal (repeatable)
  --no-builtins         only check --forbid / --forbid-pattern
  --forbid-pattern <re> a regex that must not match (repeatable)
  --json                machine-readable output
  --quiet               print nothing, just set the exit code
  --help

Globs are expanded, so quote them: 'dist/**/*.js'

Examples
  bundle-leak-check 'dist/**/*.js'
  bundle-leak-check dist/widget.js --forbid api.internal.example --forbid x-api-key
  bundle-leak-check dist/*.js --allow source-map-ref --json

Exit codes: 0 clean, 1 findings, 2 bad usage or unreadable file.`);
  process.exit(argv.length === 0 ? 2 : 0);
}

const patterns = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const paths = [];
for (const p of patterns) {
  if (/[*?[\]]/.test(p)) { for await (const f of glob(p)) paths.push(f); }
  else paths.push(p);
}

if (paths.length === 0) {
  console.error('bundle-leak-check: no files matched');
  process.exit(2);
}

const report = await scanFiles(paths, {
  forbid: many('forbid'),
  allow: many('allow'),
  builtins: !has('no-builtins'),
  forbidPattern: many('forbid-pattern').map((s) => new RegExp(s, 'g')),
});

if (has('json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (!has('quiet')) {
  for (const f of report.files) {
    if (f.error) { console.error(`✗ ${f.path}: ${f.error}`); continue; }
    if (!f.findings.length) { console.log(`✓ ${f.path} (${f.bytes} bytes)`); continue; }
    console.error(`✗ ${f.path} — ${f.findings.length} finding(s)`);
    for (const x of f.findings) {
      console.error(`    line ${x.line}  [${x.id}] ${x.hint}`);
      console.error(`      ${x.match}`);
      console.error(`      …${x.context}…`);
    }
  }
  if (report.ok) {
    console.error(`\nclean: ${report.files.length} file(s)`);
  } else {
    // An unreadable file is a failure too, and saying "0 finding(s)" when the
    // real problem is a missing path sends people looking in the wrong place.
    const parts = [];
    if (report.total) parts.push(`${report.total} finding(s)`);
    if (report.errors) parts.push(`${report.errors} unreadable file(s)`);
    console.error(`\nFAILED: ${parts.join(' and ')} across ${report.files.length} file(s)`);
  }
}

process.exit(report.errors ? 2 : report.total ? 1 : 0);
