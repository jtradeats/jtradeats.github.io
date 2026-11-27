// End to end through the Worker: a number the calendar once showed from a real source survives a cold start with every source down. Run: node --test test/ledger.e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'worker-ledger-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));

const NOW = Date.parse('2026-11-19T04:00:00Z');
const kv = (store, hide = []) => ({
  get: async (k, t) => (hide.includes(k) || !(k in store) ? null : (t === 'json' ? JSON.parse(store[k]) : store[k])),
  put: async (k, v) => { store[k] = String(v); },
});
const FFROW = (title, fc, pv, ac) => ({ title, country: 'USD', date: '2026-11-17T08:30:00-05:00', impact: 'High', forecast: fc, previous: pv, actual: ac });

async function run(tag, store, ffUp, hide) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => NOW;
  globalThis.fetch = async u => {
    u = String(u.url || u);
    if (ffUp && u.includes('ff_calendar_thisweek')) return new Response(JSON.stringify([FFROW('Retail Sales m/m', '0.1%', '0.8%', '0.2%')]), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const pending = [];
  try {
    const { default: w } = await import(pathToFileURL(ix).href + '?' + tag);
    const r = await w.fetch(new Request('https://x.workers.dev/calendar'), { MARKET_KV: kv(store, hide) }, { waitUntil: p => pending.push(p), passThroughOnException() {} });
    const j = await r.json();
    await Promise.all(pending);
    return j;
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
const find = j => j.events.find(e => e.id === 'retail|2026-11-17|main');

test('a calendar-feed actual is written to the ledger, and a cold start with every source down still shows it with its tag', async () => {
  const store = {};
  const a = await run('led-a', store, true);
  assert.equal(find(a).ac, '0.2%'); assert.equal(find(a).sr.ac, 'Fair Economy');
  assert.ok(store['calendar:ledger'], 'the ledger was saved');
  assert.equal(JSON.parse(store['calendar:ledger']).rows['retail|2026-11-17|main'].ac, '0.2%');
  const b = await run('led-b', store, false, ['calendar:last']);   // a new isolate, Forex Factory down, its KV copy not available
  assert.equal(find(b).ac, '0.2%'); assert.equal(find(b).sr.ac, 'Fair Economy');
  assert.ok(b.ledger.restored >= 1);
});

test('without a ledger the same cold start shows no actual (what the ledger is for)', async () => {
  const b = await run('led-c', {}, false);
  assert.ok(find(b).ac == null || find(b).sr.ac === 'ref');
});
