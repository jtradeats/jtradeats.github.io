import assert from 'node:assert/strict';
import { tvIngest, loadTv, tvOverlay, tvWeekly, tvHealth, TV_STALE_MS, TV_MAX_LAG_MS } from './tv.js';

// minimal D1 mock: one row table
function mockDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...a) { this.a = a; return this; },
        async run() { if (sql.startsWith('INSERT')) rows.set(1, { body: this.a[0], f: this.a[1] }); return { success: true }; },
        async first() { return rows.get(1) || null; },
      };
    },
  };
}
const quote = (price, prev, t) => { price = Number(price); const o = { p: +price.toFixed(4), t: t ?? null }; if (prev != null && Number(prev) !== 0) { o.c = +(price - prev).toFixed(4); o.pc = +(((price - prev) / prev) * 100).toFixed(3); } return o; };
const labels = new Set(['NQ1!', 'ES1!', 'CL1!']);
const NOW = 1_800_000_000_000;
const req = body => ({ text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
const good = (over = {}) => ({ v: 1, s: 'sek', ts: NOW - 2000, lag: 700, q: { 'NQ1!': [21000.25, 20900], 'ES1!': [6000, 5990.5] }, ...over });
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('no secret configured -> 503', async () => assert.equal((await tvIngest(req(good()), { DB: mockDb() }, labels, NOW)).status, 503));
await t('no D1 -> 503', async () => assert.equal((await tvIngest(req(good()), { TV_SECRET: 'sek' }, labels, NOW)).status, 503));
await t('wrong secret -> 401', async () => assert.equal((await tvIngest(req(good({ s: 'nope' })), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 401));
await t('missing secret -> 401', async () => { const b = good(); delete b.s; assert.equal((await tvIngest(req(b), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 401); });
await t('not json -> 400', async () => assert.equal((await tvIngest(req('hello'), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 400));
await t('too large -> 413', async () => assert.equal((await tvIngest(req('x'.repeat(5000)), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 413));
await t('bad version -> 400', async () => assert.equal((await tvIngest(req(good({ v: 2 })), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 400));
await t('clock far off -> 400', async () => assert.equal((await tvIngest(req(good({ ts: NOW - 3_600_000 })), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 400));
await t('good push stored', async () => {
  const db = mockDb(); const r = await tvIngest(req(good()), { TV_SECRET: 'sek', DB: db }, labels, NOW);
  assert.equal(r.status, 200); assert.equal(r.out.n, 2); assert.deepEqual(JSON.parse(db.rows.get(1).body).q['NQ1!'], [21000.25, 20900]);
});
await t('unknown label, bad price, 30% jump dropped per symbol', async () => {
  const db = mockDb();
  const r = await tvIngest(req(good({ q: { 'NQ1!': [21000, 20900], 'XX1!': [1, 1], 'ES1!': [0, 5990], 'CL1!': [95, 60] } })), { TV_SECRET: 'sek', DB: db }, labels, NOW);
  assert.equal(r.status, 200); assert.equal(r.out.n, 1); assert.equal(r.out.rejected.length, 3);
});
await t('null prior close allowed', async () => {
  const r = await tvIngest(req(good({ q: { 'NQ1!': [21000, null] } })), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW);
  assert.equal(r.status, 200);
});
await t('nothing usable -> 400', async () => assert.equal((await tvIngest(req(good({ q: { 'XX1!': [1, 1] } })), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 400));
await t('D1 failure -> 500, no throw', async () => {
  const db = { prepare() { return { bind() { return this; }, run: async () => { throw new Error('d1 down'); } }; } };
  assert.equal((await tvIngest(req(good()), { TV_SECRET: 'sek', DB: db }, labels, NOW)).status, 500);
});

// overlay
const yahoo = { label: 'NQ1!', kind: 'fut', p: 20990, t: NOW - 600000, c: 90, pc: 0.43, src: 'yahoo:NQ=F', f: NOW - 20000, contract: 'E-Mini Nasdaq 100 Dec 26', rolledAt: 123, stale: true };
const tvRow = (over = {}) => ({ f: NOW - 30000, ts: NOW - 31000, lag: 800, q: { 'NQ1!': [21000.25, 20900] }, rej: [], ...over });
await t('overlay replaces price, recomputes change, keeps contract and rolledAt', async () => {
  const o = tvOverlay(yahoo, tvRow(), NOW, quote);
  assert.equal(o.p, 21000.25); assert.equal(o.src, 'tv'); assert.equal(o.live, true); assert.equal(o.c, 100.25); assert.equal(o.pc, 0.48);
  assert.equal(o.contract, yahoo.contract); assert.equal(o.rolledAt, 123); assert.equal(o.stale, undefined); assert.equal(o.t, NOW - 31000);
});
await t('overlay fills an item Yahoo failed on', async () => {
  const o = tvOverlay({ label: 'NQ1!', kind: 'fut', p: null }, tvRow(), NOW, quote);
  assert.equal(o.p, 21000.25);
});
await t('stale push -> Yahoo untouched', async () => assert.equal(tvOverlay(yahoo, tvRow({ f: NOW - TV_STALE_MS - 1 }), NOW, quote), yahoo));
await t('delayed feed (big lag) -> Yahoo untouched, never called live', async () => assert.equal(tvOverlay(yahoo, tvRow({ lag: TV_MAX_LAG_MS + 1 }), NOW, quote), yahoo));
await t('symbol not in push -> untouched', async () => { const it = { ...yahoo, label: 'ES1!' }; assert.equal(tvOverlay(it, tvRow(), NOW, quote), it); });
await t('no push at all -> untouched', async () => assert.equal(tvOverlay(yahoo, null, NOW, quote), yahoo));


// week opens + weekly overlay
const WK = (over = {}) => ({ ...good({ q: { 'NQ1!': [21000, 20900], 'ES1!': [6000, 5990] } }), w: { 'NQ1!': [20800, NOW - 2 * 86400000], 'ES1!': [5950, NOW - 2 * 86400000] }, ...over });
await t('week opens are stored', async () => {
  const db = mockDb(); const r = await tvIngest(req(WK()), { TV_SECRET: 'sek', DB: db }, labels, NOW);
  assert.equal(r.status, 200); assert.equal(r.out.week_opens, 2); assert.deepEqual(JSON.parse(db.rows.get(1).body).w['NQ1!'], [20800, NOW - 2 * 86400000]);
});
await t('bad week opens dropped one by one, prices still stored', async () => {
  const db = mockDb();
  const r = await tvIngest(req(WK({ w: { 'NQ1!': [20800, NOW - 20 * 86400000], 'ES1!': [0, NOW], 'XX1!': [1, NOW], 'CL1!': ['a', 'b'] } })), { TV_SECRET: 'sek', DB: db }, labels, NOW);
  assert.equal(r.status, 200); assert.equal(r.out.n, 2); assert.equal(r.out.week_opens, 0); assert.equal(r.out.rejected.length, 4);
});
await t('a push without w still works (old Pine script)', async () => assert.equal((await tvIngest(req(good()), { TV_SECRET: 'sek', DB: mockDb() }, labels, NOW)).status, 200));

const map = { NQ: 'NQ1!', ES: 'ES1!', DOW: 'YM1!' };
const wbody = items => JSON.stringify({ updated: 1, items });
const wi = (label, over = {}) => ({ label, name: label, p: 100, c: 1, pc: 1, open: 99, ot: 5, t: NOW - 800000, stale: false, late: true, flag: 'x', was: 1, ...over });
const wtv = (over = {}) => ({ f: NOW - 30000, ts: NOW - 31000, lag: 800, q: { 'NQ1!': [21000, 20900], 'ES1!': [6000, 5990] }, w: { 'NQ1!': [20800, 777], 'ES1!': [5950, 777] }, rej: [], ...over });
await t('weekly: live price and week open, change recomputed, yahoo-only fields cleared', async () => {
  const o = JSON.parse(tvWeekly(wbody([wi('NQ'), wi('ES'), wi('DOW')]), wtv(), NOW, map));
  const nq = o.items[0];
  assert.equal(nq.p, 21000); assert.equal(nq.open, 20800); assert.equal(nq.ot, 777); assert.equal(nq.c, 200); assert.equal(nq.pc, 0.962);
  assert.equal(nq.live, true); assert.equal(nq.src, 'tv'); assert.equal(nq.late, undefined); assert.equal(nq.flag, undefined); assert.equal(nq.stale, undefined);
  assert.equal(o.items[2].p, 100);   // DOW had no pushed price: untouched
  assert.equal(o.updated, 1);        // the rest of the body survives
});
await t('weekly: a Yahoo roll flag keeps that item on weekly.js numbers', async () => {
  const o = JSON.parse(tvWeekly(wbody([wi('NQ', { rolled: true })]), wtv(), NOW, map));
  assert.equal(o.items[0].p, 100); assert.equal(o.items[0].live, undefined);
});
await t('weekly: stale, delayed, no w, no push, bad json -> body returned as is', async () => {
  const b = wbody([wi('NQ')]);
  assert.equal(tvWeekly(b, wtv({ f: NOW - TV_STALE_MS - 1 }), NOW, map), b);
  assert.equal(tvWeekly(b, wtv({ lag: TV_MAX_LAG_MS + 1 }), NOW, map), b);
  const nw = wtv(); delete nw.w; assert.equal(tvWeekly(b, nw, NOW, map), b);
  assert.equal(tvWeekly(b, null, NOW, map), b);
  assert.equal(tvWeekly('not json', wtv(), NOW, map), 'not json');
  assert.equal(tvWeekly('{"items":5}', wtv(), NOW, map), '{"items":5}');
});

// load + health
await t('loadTv reads the row, survives D1 errors, health reports', async () => {
  const db = mockDb(); await tvIngest(req(good()), { TV_SECRET: 'sek', DB: db }, labels, NOW);
  const row = await loadTv({ DB: db }, NOW + 20000);
  assert.equal(row.q['ES1!'][0], 6000);
  const h = tvHealth(row, { TV_SECRET: 'sek', DB: db }, NOW + 20000);
  assert.equal(h.live, true); assert.equal(h.push_age_s, 20); assert.deepEqual(h.symbols, ['NQ1!', 'ES1!']);
  const bad = { prepare() { return { first: async () => { throw new Error('boom'); } }; } };
  assert.equal(await loadTv({ DB: bad }, NOW + 60000), null);
  assert.equal(tvHealth(null, { DB: bad }, NOW).live, false);
});
console.log(`\n${n} checks passed`);
