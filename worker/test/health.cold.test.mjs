// P8.36: /health reads stored state (KV and D1), not one isolate's memory. A brand-new isolate (memory empty) must report what the pollers hold.
// Run: node --test test/health.cold.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'worker-health-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));
const { WIRE_KV, newMemo } = await import(pathToFileURL(join(tmp, 'src', 'wire.js')).href);

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({ bind: (...a) => wrap(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(x => ({ ...x })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; } });
  return { prepare: sql => wrap(sql), batch: async st => { for (const s of st) await s.run(); return []; } };
}
const kvStore = init => { const store = {}; for (const [k, v] of Object.entries(init || {})) store[k] = JSON.stringify(v); return { store, get: async (k, t) => (k in store ? (t === 'json' ? JSON.parse(store[k]) : store[k]) : null), put: async (k, v) => { store[k] = String(v); } }; };
const NOW = Date.parse('2026-11-24T10:00:00Z');
async function health(tag, env) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => NOW; globalThis.fetch = async () => new Response('no', { status: 404 });
  try {
    const { default: worker } = await import(pathToFileURL(ix).href + '?' + tag);
    const r = await worker.fetch(new Request('https://x.workers.dev/health'), env, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(r.status, 200); return r.json();
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
const policyFacts = { at: NOW - 3600e3, checked: '2026-11-24', lower: 3.75, upper: 4.0, decision: null };
const stored = () => ({
  'calendar:last': { at: NOW - 240e3, events: [] },
  'curve:last': { asof: '2026-11-21', updated: '2026-11-22T01:00:00Z', check: { status: 'ok' } },
  [WIRE_KV]: { ...newMemo(), rows: { 'cpi|m/m': { a: '0.3%' } }, log: [{ agree: true, postLagS: 20 }] },
  'policy:facts': { facts: policyFacts, vote: null },
});

test('a fresh isolate reports the stored copies: Fair Economy, curve, wire, policy and the official download mark', async () => {
  const env = { MARKET_KV: kvStore(stored()), DB: d1() };
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS poll_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)').run();
  await env.DB.prepare('INSERT INTO poll_meta (k, v) VALUES (?1, ?2)').bind('off_ok', NOW - 1800e3).run();
  const h = await health('c1', env);
  assert.equal(h.calendar.feed, 'ok'); assert.equal(h.calendar.feed_age_s, 240);
  assert.equal(h.calendar.official, 'ok'); assert.equal(h.calendar.official_age_s, 1800); assert.equal(h.poller.official_ok_age_s, 1800);
  assert.equal(h.calendar.wire.feed, 'idle'); assert.equal(h.calendar.wire.rows, 1); assert.equal(h.calendar.wire.compared, 1);
  assert.equal(h.curve.asof, '2026-11-21'); assert.equal(h.curve.check, 'ok'); assert.ok(h.curve.age_s > 0, 'the age comes from the saved copy');
  assert.equal(h.policy.loaded, true); assert.equal(h.policy.range, '3.75-4.00%');
});

test('nothing stored: honest empty answers, still HTTP 200, no D1 and no KV', async () => {
  const h = await health('c2', {});
  assert.equal(h.calendar.feed, 'none'); assert.equal(h.calendar.feed_age_s, null);
  assert.equal(h.calendar.official, 'none'); assert.equal(h.calendar.official_age_s, null);
  assert.equal(h.calendar.wire.feed, 'idle'); assert.equal(h.calendar.wire.rows, 0);
  assert.equal(h.curve.asof, null); assert.equal(h.policy.loaded, false); assert.equal(h.poller.d1, false);
  const h2 = await health('c3', { MARKET_KV: kvStore(), DB: d1() });   // stores exist but are empty
  assert.equal(h2.calendar.feed, 'none'); assert.equal(h2.calendar.official, 'none'); assert.equal(h2.poller.feed_429_age_s, null);
});

test('the shared failure marks show on a cold read, so a 429 seen by another isolate is visible here', async () => {
  const env = { MARKET_KV: kvStore(), DB: d1() };
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS poll_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)').run();
  await env.DB.prepare('INSERT INTO poll_meta (k, v) VALUES (?1, ?2)').bind('ff_429', NOW - 90e3).run();
  const h = await health('c4', env);
  assert.equal(h.poller.feed_429_age_s, 90); assert.equal(h.poller.feed_err_age_s, null);
});
