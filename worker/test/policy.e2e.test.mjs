// P8.9 end to end through the Worker: FRED's target-range series and the Fed statement mocked. Run: node --test test/policy.e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'worker-policy-'));
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
  return { prepare: sql => wrap(sql), batch: async st => { for (const s of st) await s.run(); return []; } };
}
const kvStore = () => { const store = {}, puts = []; return { store, puts, get: async (k, t) => (k in store ? (t === 'json' ? JSON.parse(store[k]) : store[k]) : null), put: async (k, v) => { puts.push(k); store[k] = String(v); } }; };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// daily observations for DFEDTARU / DFEDTARL up to `last`; steps = [[effective date, upper]]; lower = upper - 0.25
function obs(sid, last, steps) {
  const rows = []; let u = steps[0][1];
  for (let d = '2026-06-01'; d <= last; d = addDays(d, 1)) { for (const [e, v] of steps) if (e === d) u = v; rows.push({ date: d, value: String(sid === 'DFEDTARU' ? u : u - 0.25), realtime_start: last, realtime_end: last }); }
  return rows;
}
const HIKE = [['2026-06-01', 3.75], ['2026-09-17', 4.00]];
const FOR = '<p>Voting for the monetary policy action were A, Chair.</p>';
const STMT = FOR + '<p>Voting against this action were Lisa D. Cook and Beth M. Hammack, who preferred to raise the target range by 1/4 percentage point.</p>';

// one world: what FRED says (last observation + steps), what the statement page says (html or an error), and every request made
function world(o) {
  const calls = [];
  const fetch = async (u) => {
    u = String(u.url || u); calls.push(u);
    const url = new URL(u);
    if (url.hostname === 'api.stlouisfed.org') {
      const sid = url.searchParams.get('series_id');
      if (sid === 'DFEDTARU' || sid === 'DFEDTARL') return new Response(JSON.stringify({ observations: obs(sid, o.last, o.steps) }), { status: 200 });
      return new Response('nope', { status: 404 });
    }
    if (url.hostname === 'www.federalreserve.gov') return o.stmt ? new Response(o.stmt, { status: 200 }) : new Response('x', { status: 404 });
    return new Response('nope', { status: 404 });
  };
  return { fetch, calls, o };
}
async function call(w, tag, iso, path, env) {
  const realNow = Date.now, realFetch = globalThis.fetch, pending = [];
  Date.now = () => Date.parse(iso); globalThis.fetch = w.fetch;
  try {
    const { default: worker } = await import(pathToFileURL(ix).href + '?' + tag);
    const r = await worker.fetch(new Request('https://x.workers.dev' + path), env, { waitUntil: p => pending.push(p), passThroughOnException() {} });
    const j = await r.json(); await Promise.all(pending); return j;
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
async function tick(w, tag, iso, cron, env) {
  const realNow = Date.now, realFetch = globalThis.fetch, pending = [];
  Date.now = () => Date.parse(iso); globalThis.fetch = w.fetch;
  try {
    const { default: worker } = await import(pathToFileURL(ix).href + '?' + tag);
    await worker.scheduled({ cron, scheduledTime: Date.parse(iso) }, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
const fredCalls = w => w.calls.filter(u => /DFEDTAR/.test(u)).length;

test('19 Nov, nothing built yet: the first calendar build starts the job, the next one shows the built backdrop, KV gets one write', async () => {
  const w = world({ last: '2026-11-18', steps: HIKE, stmt: STMT }), kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  const a = await call(w, 'p1', '2026-11-19T17:00:00Z', '/calendar', env);
  assert.ok(a.backdrop.text, 'the first answer has a backdrop (the file\'s, or the built one if the job was quick)');
  const b = await call(w, 'p1', '2026-11-19T17:01:00Z', '/calendar?debug=1', env);
  assert.equal(b.backdrop.built, true); assert.equal(b.backdrop.checked, '2026-11-19'); assert.equal(b.backdrop.asof, '2026-10-28');
  assert.equal(b.backdrop.text, 'The Fed raised the target range by 25 bp in September to 3.75-4.00% and held in October. 2 dissents at the latest meeting (2 preferred a hike). Next decision: Wed 9 Dec.');
  assert.equal(b.debug.policy.using, 'built'); assert.equal(b.debug.policy.vote.v.n, 2);
  assert.deepEqual(kv.puts.filter(k => k === 'policy:facts'), ['policy:facts']);
  assert.ok(w.calls.some(u => u.endsWith('monetary20261028a.htm')), 'the statement of the last decision was read');
  assert.equal(b.audit.issues.filter(i => /^policy_|^stance/.test(i.code)).length, 0);
});

test('the daily run: a quiet poller tick builds the facts with its own invocation; the next tick does not ask FRED again; a day later it does', async () => {
  const w = world({ last: '2026-11-18', steps: HIKE, stmt: STMT }), kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  await tick(w, 'p2', '2026-11-19T14:02:00Z', '*/2 * * * *', env);   // minute 2: not a 10-minute mark, nothing near
  assert.equal(fredCalls(w), 2); assert.equal(kv.puts.filter(k => k === 'policy:facts').length, 1);
  await tick(w, 'p2', '2026-11-19T14:04:00Z', '*/2 * * * *', env);
  assert.equal(fredCalls(w), 2, 'nothing due on the next tick');
  const h = await call(w, 'p2', '2026-11-19T14:04:30Z', '/health', env);
  assert.equal(h.policy.loaded, true); assert.equal(h.policy.range, '3.75-4.00%'); assert.equal(h.policy.vote, 'found'); assert.ok(h.poller.policy_ok_age_s <= 300);
  await tick(w, 'p2b', '2026-11-20T14:02:00Z', '*/2 * * * *', env);   // a new isolate a day later: the KV copy is 24 h old
  assert.equal(fredCalls(w), 4); assert.equal(kv.puts.filter(k => k === 'policy:facts').length, 2, 'one write when the day turns');
});

test('/health in a fresh isolate loads the saved facts first (the 21 Nov reading said loaded:false although the job had run)', async () => {
  const w = world({ last: '2026-11-18', steps: HIKE, stmt: STMT }), kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  await tick(w, 'h1', '2026-11-19T14:02:00Z', '*/2 * * * *', env);   // the poller built the facts and saved them to KV
  const h = await call(w, 'h2', '2026-11-19T14:30:00Z', '/health', env);   // another isolate: memory is empty, KV has the facts
  assert.equal(h.policy.loaded, true); assert.equal(h.policy.range, '3.75-4.00%'); assert.equal(h.policy.vote, 'found');
});

test('decision day (R62): after 14:00 ET on 9 Dec the page never gets the old range; the next day the new one appears', async () => {
  const kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  const w1 = world({ last: '2026-12-08', steps: HIKE, stmt: STMT });
  await tick(w1, 'p3', '2026-12-09T14:02:00Z', '*/2 * * * *', env);   // 09:02 ET: the morning build
  const w2 = world({ last: '2026-12-09', steps: HIKE, stmt: STMT });
  const a = await call(w2, 'p3', '2026-12-09T19:05:00Z', '/calendar', env);   // 14:05 ET
  assert.equal(a.backdrop.pending, '2026-12-09'); assert.ok(!/3\.75|4\.00/.test(a.backdrop.text)); assert.match(a.backdrop.text, /decision of 9 Dec is not yet reflected/i);
  assert.ok(fredCalls(w2) >= 2, 'the first build after the decision refreshed the facts in the background');
  const n = fredCalls(w2);
  await call(w2, 'p3', '2026-12-09T19:08:00Z', '/calendar', env);
  assert.equal(fredCalls(w2), n, 'not again within 10 minutes');
  await call(w2, 'p3', '2026-12-09T19:20:00Z', '/calendar', env);
  assert.ok(fredCalls(w2) > n, 'again after 10 minutes');
  const w3 = world({ last: '2026-12-11', steps: [...HIKE, ['2026-12-10', 3.75]], stmt: STMT.replace('raise', 'lower') });
  await call(w3, 'p3', '2026-12-11T15:00:00Z', '/calendar', env);
  const c = await call(w3, 'p3', '2026-12-11T15:01:00Z', '/calendar', env);
  assert.equal(c.backdrop.pending, null); assert.match(c.backdrop.text, /^The Fed cut the target range by 25 bp in December to 3\.50-3\.75%\. 2 dissents/);
  assert.ok(c.audit.issues.some(i => i.code === 'stance_changed'), 'the Fed explanations were reviewed for "hike; hold"');
});

test('the Fed statement cannot be read: the facts are still built, no vote sentence, and it is tried again later, four times at most', async () => {
  const w = world({ last: '2026-11-18', steps: HIKE, stmt: null }), kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  await tick(w, 'p4', '2026-11-19T14:02:00Z', '*/2 * * * *', env);
  const b = await call(w, 'p4', '2026-11-19T14:03:00Z', '/calendar', env);
  assert.equal(b.backdrop.built, true); assert.ok(!/dissent/i.test(b.backdrop.text)); assert.ok(!/vote from/.test(b.backdrop.src));
  const h = await call(w, 'p4', '2026-11-19T14:03:10Z', '/health', env);
  assert.match(h.policy.vote, /not found \(1 tries\)/);
  w.o.stmt = STMT;   // the page is readable 7 hours later
  await tick(w, 'p4b', '2026-11-19T21:02:00Z', '*/2 * * * *', env);
  const c = await call(w, 'p4c', '2026-11-19T21:03:00Z', '/calendar', env);
  assert.match(c.backdrop.text, /2 dissents/);
});

test('no FRED_KEY: the hand-written backdrop stays and the chip says why; FRED down: the old facts stay and the error is shown', async () => {
  const w = world({ last: '2026-11-18', steps: HIKE, stmt: STMT });
  const a = await call(w, 'p5', '2026-11-19T17:00:00Z', '/calendar', { MARKET_KV: kvStore(), DB: d1() });
  assert.equal(a.backdrop.built, undefined); assert.ok(a.audit.issues.some(i => i.code === 'policy_nokey'));
  const kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  await tick(w, 'p6', '2026-11-19T14:02:00Z', '*/2 * * * *', env);
  const down = { fetch: async () => new Response('boom', { status: 500 }), calls: [] };
  await tick(down, 'p6b', '2026-11-20T14:02:00Z', '*/2 * * * *', env);
  const h = await call(w, 'p6b', '2026-11-20T14:03:00Z', '/health', env);
  assert.equal(h.policy.loaded, true); assert.equal(h.policy.checked, '2026-11-19'); assert.match(String(h.policy.error), /HTTP 500|FRED/);
});

test('the hand-written backdrop (dated 14 Nov) wins while it is newer than the facts; once the facts are confirmed on or after that date the built one takes over', async () => {
  const w = world({ last: '2026-11-18', steps: HIKE, stmt: STMT }), kv = kvStore(), env = { FRED_KEY: 'k', MARKET_KV: kv, DB: d1() };
  await tick(w, 'p7', '2026-11-10T14:02:00Z', '*/2 * * * *', env);   // facts confirmed 10 Nov
  const a = await call(w, 'p7', '2026-11-10T17:00:00Z', '/calendar?debug=1', env);
  assert.equal(a.backdrop.built, undefined); assert.match(a.debug.policy.using, /file \(newer/);
  await tick(w, 'p7b', '2026-11-15T14:02:00Z', '*/2 * * * *', env);   // confirmed again after 14 Nov
  const b = await call(w, 'p7b', '2026-11-15T17:00:00Z', '/calendar', env);
  assert.equal(b.backdrop.built, true); assert.equal(b.backdrop.checked, '2026-11-15');
});
