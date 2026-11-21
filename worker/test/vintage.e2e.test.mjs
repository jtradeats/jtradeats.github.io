// P8.18 end to end through the Worker, FRED mocked: the 25 Nov GDP second estimate before and after FRED updates, the lag log in D1, the FMP status. Run: node --test test/vintage.e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'worker-vint-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({ bind: (...a) => wrap(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(x => ({ ...x })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; } });
  return { db, prepare: sql => wrap(sql), batch: async st => { for (const s of st) await s.run(); return []; } };
}
const kv = store => ({ get: async (k, t) => (k in store ? (t === 'json' ? JSON.parse(store[k]) : store[k]) : null), put: async (k, v) => { store[k] = String(v); } });
const obsRows = (cur) => [['2026-04-01', '3.8'], ['2026-07-01', String(cur)]];
// FRED's answers. Current vintage: observations with today's realtime. Vintage request (realtime_start in the URL): one row per value the observation held.
function fred(u, cur, revisedOn) {
  const url = new URL(u);
  if (url.hostname !== 'api.stlouisfed.org' || url.searchParams.get('series_id') !== 'A191RL1Q225SBEA') return new Response('nope', { status: 404 });
  if (url.searchParams.get('realtime_start')) {
    const rows = [{ date: '2026-04-01', value: '3.8', realtime_start: '2026-10-09', realtime_end: '9999-12-31' }, { date: '2026-07-01', value: '3.4', realtime_start: '2026-10-29', realtime_end: revisedOn ? '2026-11-24' : '9999-12-31' }];
    if (revisedOn) rows.push({ date: '2026-07-01', value: String(cur), realtime_start: revisedOn, realtime_end: '9999-12-31' });
    return new Response(JSON.stringify({ observations: rows }), { status: 200 });
  }
  return new Response(JSON.stringify({ observations: obsRows(cur).map(([date, value]) => ({ date, value, realtime_start: '2026-11-25', realtime_end: '9999-12-31' })) }), { status: 200 });
}

async function call(tag, iso, path, env, cur, revisedOn) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => Date.parse(iso);
  globalThis.fetch = async u => fred(String(u.url || u), cur, revisedOn);
  const pending = [];
  try {
    const { default: w } = await import(pathToFileURL(ix).href + '?' + tag);
    const r = await w.fetch(new Request('https://x.workers.dev' + path), env, { waitUntil: p => pending.push(p), passThroughOnException() {} });
    const j = await r.json();
    await Promise.all(pending);
    return j;
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
const row = j => j.events.find(e => e.id === 'gdp|2026-11-25|main');

test('25 Nov 08:35 ET: FRED still on the advance value: no actual, "awaiting", previous kept, reason listed, nothing in the lag log', async () => {
  const env = { FRED_KEY: 'k', MARKET_KV: kv({}), DB: d1() };
  const j = await call('v-a', '2026-11-25T13:35:00Z', '/calendar?debug=1', env, 3.4, null);
  const g = row(j);
  assert.equal(g.ac ?? null, null); assert.equal(g.aw, 1); assert.equal(g.pv, '3.4%');
  assert.equal(j.official.held, 1); assert.ok(j.official.awaiting >= 1);
  assert.match(j.debug.official.skipped.find(s => s.id === g.id).why, /held since 2026-10-29/);
  assert.deepEqual(j.debug.official.vintages.A191RL1Q225SBEA['2026-07-01'], { v: 3.4, rs: '2026-10-29' });
  const h = await call('v-a', '2026-11-25T13:35:30Z', '/health', env, 3.4, null);
  assert.deepEqual(h.official.lag.filter(x => x.id === g.id), []);
});

test('25 Nov 08:41 ET: FRED has 3.2 with a new vintage: the actual shows, tagged FRED, and the lag log records 11 minutes', async () => {
  const env = { FRED_KEY: 'k', MARKET_KV: kv({}), DB: d1() };
  const j = await call('v-b', '2026-11-25T13:41:00Z', '/calendar', env, 3.2, '2026-11-25');
  const g = row(j);
  assert.equal(g.ac, '3.2%'); assert.equal(g.sr.ac, 'FRED'); assert.equal(g.pv, '3.4%'); assert.ok(!g.aw);
  assert.equal(j.official.held, 0);
  const h = await call('v-b', '2026-11-25T13:41:30Z', '/health', env, 3.2, '2026-11-25');
  const lag = h.official.lag.find(x => x.id === g.id);
  assert.deepEqual(lag, { id: g.id, release: '2026-11-25T13:30:00Z', lag_s: 660, src: 'FRED' });
  // the first sighting is kept: a later isolate that sees the same actual does not change the log
  await call('v-b2', '2026-11-25T14:30:00Z', '/calendar', env, 3.2, '2026-11-25');
  const h2 = await call('v-b2', '2026-11-25T14:30:10Z', '/health', env, 3.2, '2026-11-25');
  assert.equal(h2.official.lag.find(x => x.id === g.id).lag_s, 660);
});

test('FRED unreachable for the vintages only: the numbers rule still protects the row, and the error is shown', async () => {
  const env = { FRED_KEY: 'k', MARKET_KV: kv({}), DB: d1() };
  const realFetch = globalThis.fetch, realNow = Date.now;
  Date.now = () => Date.parse('2026-11-25T13:35:00Z');
  globalThis.fetch = async u => { u = String(u.url || u); if (u.includes('realtime_start')) return new Response('boom', { status: 500 });
    return new URL(u).searchParams.get('series_id') === 'A191RL1Q225SBEA' ? fred(u, 3.4, null) : new Response(JSON.stringify({ observations: [{ date: '2026-01-01', value: '1' }] }), { status: 200 }); };   // the other series answer, so only the vintages fail
  try {
    const { default: w } = await import(pathToFileURL(ix).href + '?v-c');
    const j = await (await w.fetch(new Request('https://x.workers.dev/calendar'), env, { waitUntil() {}, passThroughOnException() {} })).json();
    assert.equal(row(j).ac ?? null, null);
    assert.match(String(j.official.error), /A191RL1Q225SBEA vintages/);
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
});

test('/health and /calendar never say fmp "no-key" while a key is set', async () => {
  const env = { FRED_KEY: 'k', FMP_KEY: 'x', MARKET_KV: kv({}), DB: d1() };
  const h = await call('v-d', '2026-11-25T13:35:00Z', '/health', env, 3.4, null);
  assert.notEqual(h.calendar.fmp, 'no-key');
  const noKey = await call('v-e', '2026-11-25T13:35:00Z', '/health', { FRED_KEY: 'k', MARKET_KV: kv({}) }, 3.4, null);
  assert.equal(noKey.calendar.fmp, 'no-key');
});
