// The background pollers (plan P8.32): nothing needs a page open. Run: node --test test/poller.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { HTMLRewriter } from 'html-rewriter-wasm';   // needs: npm i -D html-rewriter-wasm

const tmp = mkdtempSync(join(tmpdir(), 'worker-poll-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));

// the feed parser runs on the Worker's HTMLRewriter; Node has none, so the WASM build stands in (the same module instance index.js imports)
const F = await import(pathToFileURL(join(tmp, 'src', 'feed.js')).href);
F._useRunner(async (html, attach) => { const rw = new HTMLRewriter(() => {}); attach(rw); await rw.write(new TextEncoder().encode(html)); await rw.end(); rw.free(); });
const cold = () => { for (const ch of ['FinancialJuice']) Object.assign(F._stateOf(ch), { posts: [], seeded: false, at: 0, okAt: 0, failAt: 0, fullAt: 0, saved: 0, filled: 0, gapId: 0, inflight: null }); };

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({ bind: (...a) => wrap(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(x => ({ ...x })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; } });
  return { db, prepare: sql => wrap(sql), batch: async st => { for (const s of st) await s.run(); return []; } };
}
const kv = store => ({ get: async (k, t) => (k in store ? (t === 'json' ? JSON.parse(store[k]) : store[k]) : null), put: async (k, v) => { store[k] = String(v); } });
const msg = (ch, id, text) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${ch}/${id}"><div class="tgme_widget_message_bubble"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><div class="tgme_widget_message_footer"><div class="tgme_widget_message_info"><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${ch}/${id}"><time datetime="2026-11-18T15:30:00+00:00" class="time">x</time></a></span></div></div></div></div></div>`;
const page = (ch, ids) => `<html><body><section class="tgme_channel_history js-message_history">${ids.map(i => msg(ch, i, 'post ' + i)).join('')}</section></body></html>`;

async function tick(tag, iso, cron, env, ffUp = true) {
  cold();   // every tick here is a fresh isolate: the feed's memory starts empty
  const realNow = Date.now, realFetch = globalThis.fetch, calls = [];
  Date.now = () => Date.parse(iso);
  globalThis.fetch = async u => {
    u = String(u.url || u); calls.push(u);
    const m = /t\.me\/s\/(\w+)/.exec(u);
    if (m) return new Response(page(m[1], [11, 12, 13]), { status: 200 });
    if (ffUp && u.includes('ff_calendar_thisweek')) return new Response(JSON.stringify([{ title: 'Retail Sales m/m', country: 'USD', date: '2026-11-17T08:30:00-05:00', impact: 'High', forecast: '0.1%', previous: '0.8%', actual: '0.2%' }]), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const pending = [];
  try {
    const { default: w } = await import(pathToFileURL(ix).href + '?' + tag);
    await w.scheduled({ cron, scheduledTime: Date.parse(iso) }, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    const h = await (await w.fetch(new Request('https://x.workers.dev/health'), env, { waitUntil() {} })).json();
    return { calls, health: h };
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}

test('the every-minute poll stores the FinancialJuice wire in D1 with no page open, and /health shows the heartbeat and the stored counts', async () => {
  const env = { DB: d1(), MARKET_KV: kv({}) };
  const { calls, health } = await tick('p1', '2026-11-18T16:00:00Z', '* * * * *', env);
  assert.deepEqual(calls.filter(u => /t\.me\/s\//.test(u)), ['https://t.me/s/FinancialJuice'], 'one request, for FinancialJuice only: Walter Bloomberg was retired on 24 Nov');
  const rows = env.DB.db.prepare('SELECT ch, COUNT(*) AS n FROM tg_posts GROUP BY ch ORDER BY ch').all().map(x => ({ ...x }));
  assert.deepEqual(rows, [{ ch: 'FinancialJuice', n: 3 }]);
  assert.equal(health.poller.feeds_ok_age_s, 0); assert.equal(health.poller.posts.FinancialJuice.rows, 3);
  assert.ok(!('WalterBloomberg' in health.poller.posts), 'no Walter Bloomberg entry in the stored counts');
});

test('a second worker (a cold isolate) serves the stored posts even when Telegram is unreachable', async () => {
  const env = { DB: d1(), MARKET_KV: kv({}) };
  await tick('p2a', '2026-11-18T16:00:00Z', '* * * * *', env);
  const realFetch = globalThis.fetch, realNow = Date.now;
  globalThis.fetch = async () => { throw new Error('offline'); };
  Date.now = () => Date.parse('2026-11-18T22:00:00Z');   // hours later
  try {
    cold();
    const { default: w } = await import(pathToFileURL(ix).href + '?p2b');
    const j = await (await w.fetch(new Request('https://x.workers.dev/feed'), env, { waitUntil() {} })).json();
    assert.deepEqual(j.fj.posts.map(p => p.id), [13, 12, 11]);
    assert.equal(j.fj.status, 'broken', 'the poll failed, and the feed says so');
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

test('the calendar poll builds only near a release (every 2 minutes) and otherwise every 10 minutes; it stores the ledger and a heartbeat', async () => {
  const store = {}, env = { DB: d1(), MARKET_KV: kv(store) };
  const quiet = await tick('c1', '2026-11-17T20:02:00Z', '*/2 * * * *', env);   // 15:02 ET, nothing scheduled, minute 2: skip
  assert.equal(quiet.calls.length, 0);
  const near = await tick('c2', '2026-11-17T13:40:00Z', '*/2 * * * *', env);   // 10 minutes after retail sales
  assert.ok(near.calls.some(u => u.includes('ff_calendar_thisweek')), 'the calendar feeds were read');
  assert.ok(store['calendar:ledger'], 'the actual was written to the ledger');
  assert.ok(near.health.poller.calendar_near_age_s === 0);
  const ten = await tick('c3', '2026-11-17T20:10:00Z', '*/2 * * * *', env);   // minute 10 in a quiet hour: build
  assert.ok(ten.calls.some(u => u.includes('faireconomy')), 'the 10-minute build ran');
  assert.equal(ten.health.poller.calendar_age_s, 0);
});

test('with no D1 the pollers still run and never throw', async () => {
  const env = { MARKET_KV: kv({}) };
  const r = await tick('n1', '2026-11-18T16:00:00Z', '* * * * *', env);
  assert.equal(r.calls.filter(u => /t\.me\/s\//.test(u)).length, 1);
  assert.equal(r.health.poller.d1, false);
});
