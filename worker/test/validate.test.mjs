// Price validation (plan P8.16): V1 range, V2 jump. Pure functions, the shared route (/sectors, /weekly), the TradingView push and its overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesFrom, rangeFail, moveOf, checkJump, V2_RECENT_MS } from '../src/validate.js';
import { makeRoute } from '../src/route.js';
import { tvIngest, tvOverlay, tvWeekly } from '../src/tv.js';

const NQ = { label: 'NQ1!', kind: 'fut', range: [8000, 60000], move: 4 };
const Y10 = { label: 'USD10Y', kind: 'yield', range: [0, 10], move: 0.35 };
const T = 1_700_000_000_000;

test('rulesFrom keeps only items with a usable range or move and ignores a malformed range', () => {
  const r = rulesFrom([NQ, { label: 'A', kind: 'idx' }, { label: 'B', kind: 'idx', range: [5, 1] }, { label: 'C', kind: 'etf', range: ['a', 2] }, { label: 'D', kind: 'idx', move: 25 }, { label: 'E', kind: 'idx', move: 0 }, null, {}]);
  assert.deepEqual(Object.keys(r).sort(), ['D', 'NQ1!']);
  assert.deepEqual(r['NQ1!'].range, [8000, 60000]); assert.equal(r.D.range, null); assert.equal(r.D.move, 25);
});

test('V1: inside the range passes, outside, zero, NaN and a missing rule', () => {
  assert.equal(rangeFail(NQ, 25000), null);
  assert.equal(rangeFail(NQ, 8000), null); assert.equal(rangeFail(NQ, 60000), null);
  for (const p of [7999.9, 60001, 0, -5, NaN]) { const e = rangeFail(NQ, p); assert.ok(e instanceof Error && e.range === true, String(p)); assert.match(e.message, /^V1: NQ1! .* outside the range 8000 to 60000/); }
  assert.equal(rangeFail(undefined, 5), null); assert.equal(rangeFail({ label: 'X', move: 3 }, 5), null);
});

test('moveOf: percent from the prior close; a yield uses its point change', () => {
  assert.equal(moveOf(NQ, { p: 100, c: -5, pc: -4.76 }), 4.76);
  assert.equal(moveOf(Y10, { p: 4.2, c: 0.4 }), 0.4);
  assert.equal(moveOf(NQ, { p: 100 }), null);
});

test('V2: a move inside the limit is not flagged, with or without a previous reading', () => {
  assert.deepEqual(checkJump(NQ, { p: 100, c: 3, pc: 3.9 }, null, T), { unv: false, why: null });
  assert.equal(checkJump(undefined, { p: 100, pc: 40 }, null, T).unv, false);
  assert.equal(checkJump({ ...NQ, move: null }, { p: 100, pc: 40 }, null, T).unv, false);
});

test('V2: a first reading over the limit is UNVERIFIED, with the reason; the next reading that agrees confirms it', () => {
  const q1 = { p: 95, c: -5, pc: -5.0 };
  const a = checkJump(NQ, q1, { p: 99, f: T - 30000 }, T);   // the previous fetch was 4% away: a jump
  assert.equal(a.unv, true); assert.match(a.why, /^V2: NQ1! moved 5\.0% from the prior close \(limit 4\)/);
  const b = checkJump(NQ, { p: 95.3, c: -4.7, pc: -4.7 }, { p: 95, f: T }, T + 30000);   // 0.3% from the last reading: within a quarter of the limit
  assert.equal(b.unv, false);
});

test('V2: a real move that grows through the limit is not flagged on the way; a second jump to a new level is', () => {
  assert.equal(checkJump(NQ, { p: 96, c: -4, pc: -4.2 }, { p: 96.4, f: T - 30000 }, T).unv, false);   // 0.4% from the last reading
  assert.equal(checkJump(NQ, { p: 90, c: -10, pc: -10 }, { p: 96, f: T - 30000 }, T).unv, true);      // 6% in 30 s
});

test('V2: a previous reading that is old, from the future, or missing cannot confirm', () => {
  const q = { p: 95, c: -5, pc: -5 };
  assert.equal(checkJump(NQ, q, { p: 95, f: T - V2_RECENT_MS - 1 }, T).unv, true);
  assert.equal(checkJump(NQ, q, { p: 95, f: T - V2_RECENT_MS }, T).unv, false);
  assert.equal(checkJump(NQ, q, { p: 95, f: T + 5000 }, T).unv, true);
  assert.equal(checkJump(NQ, q, { p: null, f: T - 1000 }, T).unv, true);
  assert.equal(checkJump(NQ, q, undefined, T).unv, true);
});

test('V2 for a yield: points, and the tolerance is in points', () => {
  const q = { p: 4.60, c: 0.40 };
  const a = checkJump(Y10, q, { p: 4.20, f: T - 30000 }, T);
  assert.equal(a.unv, true); assert.match(a.why, /moved 0\.40 pt .*limit 0\.35/);
  assert.equal(checkJump(Y10, q, { p: 4.55, f: T - 30000 }, T).unv, false);   // 0.05 pt <= 0.35 / 4
  assert.equal(checkJump(Y10, { p: 4.5, c: 0.3 }, null, T).unv, false);
});

// ---- the shared route (/sectors, /weekly) ----
function routeWith(rule, prices) {
  let i = 0;
  const spec = { label: 'XLK', name: 'Tech', kind: 'etf', chain: [['yahoo', 'XLK']], ...rule };
  const fetchOne = async () => { const x = prices[Math.min(i++, prices.length - 1)]; if (x instanceof Error) throw x; return { p: x.p, t: T, f: Date.now(), ...(x.pc != null ? { pc: x.pc, c: x.p * x.pc / 100 } : {}) }; };
  const r = makeRoute({ name: 't', kvKey: 'k', specs: [spec], fetchOne, ttl: 0, negTtl: 0, minFresh: 0 });
  const get = async () => { await new Promise(r => setTimeout(r, 4)); return JSON.parse(await r.get({}, null, { fresh: true })).items[0]; };   // a few ms apart: STALE needs the failure to be later than the last good fetch
  return { get };
}

test('route V1: an out-of-range price is a failed fetch: last good value kept, STALE, reason in why; the next good price clears it', async () => {
  const { get } = routeWith({ range: [30, 1500] }, [{ p: 250 }, { p: 25000 }, { p: 251 }]);
  const a = await get(); assert.equal(a.p, 250); assert.ok(!a.stale && !a.why);
  const b = await get(); assert.equal(b.p, 250); assert.equal(b.stale, true); assert.match(b.why, /^V1: XLK 25000 is outside the range 30 to 1500/);
  const c = await get(); assert.equal(c.p, 251); assert.ok(!c.stale && !c.why);
});

test('route V1: a plain network failure is STALE without a V1 reason', async () => {
  const { get } = routeWith({ range: [30, 1500] }, [{ p: 250 }, new Error('HTTP 500')]);
  await get(); const b = await get();
  assert.equal(b.stale, true); assert.equal(b.why, undefined);
});

test('route V2: a jump is UNVERIFIED, then confirmed by the next fetch; a bad tick that reverts never confirms', async () => {
  const jump = routeWith({ move: 5 }, [{ p: 250, pc: 1 }, { p: 230, pc: -7.9 }, { p: 230.5, pc: -7.7 }, { p: 231, pc: -7.5 }]);
  await jump.get();
  const b = await jump.get(); assert.equal(b.unv, true); assert.match(b.why, /^V2: XLK moved 7\.9%/);
  const c = await jump.get(); assert.ok(!c.unv && !c.why);
  const d = await jump.get(); assert.ok(!d.unv);
  const tick = routeWith({ move: 5 }, [{ p: 250, pc: 1 }, { p: 230, pc: -7.9 }, { p: 250.2, pc: 1.1 }]);
  await tick.get(); assert.equal((await tick.get()).unv, true); assert.ok(!(await tick.get()).unv);
});

test('route: an item with no range or move behaves as before', async () => {
  const { get } = routeWith({}, [{ p: 250 }, { p: 25000, pc: 900 }]);
  await get(); const b = await get(); assert.equal(b.p, 25000); assert.ok(!b.stale && !b.unv);
});

// ---- the TradingView push ----
const labels = new Map([['NQ1!', 'fut'], ['USD10Y', 'yield']]);
const ranges = { 'NQ1!': [8000, 60000], USD10Y: [0, 10] };
function ingest(body, rng = ranges, now = T) {
  const env = { TV_SECRET: 's', DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } };
  return tvIngest({ text: async () => JSON.stringify({ s: 's', v: 1, ts: now, lag: 1000, ...body }) }, env, labels, now, rng);
}

test('push V1: a price outside its range is refused for that symbol only, and listed under rejected', async () => {
  const r = await ingest({ q: { 'NQ1!': [250, null], USD10Y: [4.1, null, T - 1000] } });
  assert.equal(r.status, 200); assert.equal(r.out.n, 1);
  assert.ok(r.out.rejected.some(x => /^NQ1!: 250 is outside the sane range 8000 to 60000/.test(x)));
});

test('push V1: a week open outside the range is dropped; without ranges nothing changes', async () => {
  const r = await ingest({ q: { 'NQ1!': [25000, 24800] }, w: { 'NQ1!': [90000, T - 86400000] } });
  assert.equal(r.out.week_opens, 0); assert.ok(r.out.rejected.some(x => /^w NQ1!: 90000 is outside the sane range/.test(x)));
  const r2 = await ingest({ q: { 'NQ1!': [250, null] } }, null);
  assert.equal(r2.status, 200); assert.equal(r2.out.n, 1);
});

test('push overlay: a pushed price replaces the delayed reading, so its V2 tag and reason go', () => {
  const quote = (p, pv, t) => ({ p, t, c: pv ? p - pv : undefined });
  const it = { label: 'NQ1!', kind: 'fut', p: 24000, unv: true, why: 'V2: ...', stale: true };
  const o = tvOverlay(it, { q: { 'NQ1!': [24100, 24000] }, f: T, lag: 500, ts: T }, T + 1000, quote);
  assert.equal(o.src, 'tv'); assert.ok(!('unv' in o) && !('why' in o) && !('stale' in o));
  const w = JSON.parse(tvWeekly(JSON.stringify({ items: [{ label: 'NQ', unv: true, why: 'x', p: 1 }] }), { q: { 'NQ1!': [24100, 1] }, w: { 'NQ1!': [24000, T] }, f: T, lag: 500, ts: T }, T + 1000, { NQ: 'NQ1!' }));
  assert.ok(!('unv' in w.items[0]) && !('why' in w.items[0]));
});
