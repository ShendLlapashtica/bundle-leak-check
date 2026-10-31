import { scanText, scanFiles, BUILTIN_RULES } from './index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Built from parts so this file is not itself a secret-shaped string that
// other scanners flag.
const AWS  = 'AKIA' + 'Q7FJ4LMNOPQRSTUV';
const GH   = 'ghp_' + 'a'.repeat(36);
const JWT  = 'eyJhbGciOiJIUzI1NiJ9.' + 'e30'.repeat(5) + '.' + 'x'.repeat(22);
const STRIPE = 'sk_live_' + 'b'.repeat(24);

test('catches an AWS access key id', () => {
  const f = scanText(`const k="${AWS}";`);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'aws-access-key-id');
});

test('catches GitHub, Stripe and JWT shapes', () => {
  const ids = scanText(`a="${GH}";b="${STRIPE}";c="${JWT}";`).map((x) => x.id);
  assert.ok(ids.includes('github-token'), ids.join());
  assert.ok(ids.includes('stripe-secret-key'), ids.join());
  assert.ok(ids.includes('jwt'), ids.join());
});

test('NEVER prints a secret in full', () => {
  const f = scanText(`const k="${AWS}";`);
  assert.ok(!f[0].match.includes(AWS), 'the full secret must not appear in the finding');
  assert.ok(!f[0].context.includes(AWS), 'nor in the context');
  assert.match(f[0].match, /…/, 'it should be elided');
  // Enough to identify which secret it is.
  assert.ok(f[0].match.startsWith('AKIA'));
});

test('catches credentials embedded in a URL', () => {
  const f = scanText('fetch("https://admin:hunter2@db.example.org/x")');
  assert.ok(f.some((x) => x.id === 'basic-auth-url'), JSON.stringify(f));
});

test('catches private and local hostnames', () => {
  const f = scanText('const a="http://10.1.2.3/api", b="https://billing.internal/v1";');
  assert.equal(f.filter((x) => x.id === 'private-host').length, 2);
});

test('does not flag a public hostname', () => {
  assert.equal(scanText('fetch("https://api.github.com/users")').length, 0);
});

test('catches a source map reference but not an inlined one', () => {
  assert.equal(scanText('//# sourceMappingURL=app.js.map').length, 1);
  assert.equal(scanText('//# sourceMappingURL=data:application/json;base64,e30=').length, 0);
});

test('forbidden literals: the case this was written for', () => {
  // A top-level side effect defeats tree-shaking, so a global you believed was
  // dropped ships to every page.
  const bundle = 'var a=1;window.PaidApi=api;export{a};';
  const f = scanText(bundle, { forbid: ['PaidApi', 'x-api-key'], builtins: false });
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'forbid:PaidApi');
  assert.match(f[0].hint, /PaidApi/);
});

test('forbidden literals are escaped, not treated as regex', () => {
  const f = scanText('const re="a.c";', { forbid: ['a.c'], builtins: false });
  assert.equal(f.length, 1);
  assert.equal(scanText('const x="abc";', { forbid: ['a.c'], builtins: false }).length, 0,
    '"a.c" must not match "abc"');
});

test('--forbid-pattern style regex works and is forced global', () => {
  const f = scanText('INTERNAL_A INTERNAL_B', {
    forbidPattern: [/INTERNAL_[A-Z]/],      // no /g on purpose
    builtins: false,
  });
  assert.equal(f.length, 2, 'must find both, not loop forever on the first');
});

test('allow list silences a rule by id', () => {
  const src = '//# sourceMappingURL=app.js.map';
  assert.equal(scanText(src).length, 1);
  assert.equal(scanText(src, { allow: ['source-map-ref'] }).length, 0);
});

test('ignores the documented AWS example key', () => {
  assert.equal(scanText('AKIAIOSFODNN7EXAMPLE').length, 0);
});

test('reports a line number, and handles a one-line minified bundle', () => {
  const f = scanText(`a\nb\nconst k="${AWS}";\n`);
  assert.equal(f[0].line, 3);
  const g = scanText(`var a=1;const k="${AWS}";var b=2;`);
  assert.equal(g[0].line, 1);
});

test('findings come back in file order', () => {
  const f = scanText(`x="${GH}"; y="${AWS}";`);
  assert.ok(f.length >= 2);
  for (let i = 1; i < f.length; i++) assert.ok(f[i].index >= f[i - 1].index);
});

test('scanFiles reports ok, and does not throw on a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blc-'));
  const clean = join(dir, 'clean.js');
  const dirty = join(dir, 'dirty.js');
  await writeFile(clean, 'export const a = 1;\n');
  await writeFile(dirty, `export const k = "${AWS}";\n`);

  const good = await scanFiles([clean]);
  assert.equal(good.ok, true);
  assert.equal(good.total, 0);

  const bad = await scanFiles([clean, dirty]);
  assert.equal(bad.ok, false);
  assert.equal(bad.total, 1);

  const missing = await scanFiles([join(dir, 'nope.js')]);
  assert.equal(missing.errors, 1);
  assert.equal(missing.ok, false);
  assert.ok(missing.files[0].error);
});

test('every builtin rule has a unique id and a global regex', () => {
  const ids = new Set();
  for (const r of BUILTIN_RULES) {
    assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
    ids.add(r.id);
    assert.ok(r.re.flags.includes('g'), `${r.id} must be global or exec() loops forever`);
    assert.ok(r.hint, `${r.id} needs a hint`);
  }
});

test('a clean modern bundle produces no findings', () => {
  const realistic = `
    const API="https://api.example.com/v2";
    export async function load(id){
      const r=await fetch(\`\${API}/items/\${id}\`,{headers:{accept:"application/json"}});
      if(!r.ok)throw new Error("HTTP "+r.status);
      return r.json();
    }
  `;
  assert.deepEqual(scanText(realistic), []);
});
