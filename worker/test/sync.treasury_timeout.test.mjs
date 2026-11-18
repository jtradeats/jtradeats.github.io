// The Treasury sync must report a TreasuryDirect timeout with how long it waited. Run: node --test test/sync.treasury_timeout.test.mjs
// Regression: v1.8 appended to e.message, which is read-only on the runtime's TimeoutError, so /sync showed "Cannot assign to read only property 'message'".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'worker-sync-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));

test('a TreasuryDirect timeout is recorded with the time waited, not a read-only error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => {
    u = String(u.url || u);
    if (/treasurydirect\.gov/.test(u)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response('nope', { status: 404 });
  };
  try {
    const { default: w } = await import(pathToFileURL(ix).href);
    const pending = [];
    await w.scheduled({ cron: '30 9 * * *' }, {}, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    const r = await w.fetch(new Request('https://x.workers.dev/sync'), {}, { waitUntil() {} });
    const j = await r.json();
    const err = j.sources.treasury.err || '';
    assert.match(err, /aborted due to timeout/);
    assert.match(err, /gave up after \d+ ms/);
    assert.doesNotMatch(err, /read only/);
  } finally { globalThis.fetch = realFetch; }
});
