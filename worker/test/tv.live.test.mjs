// TradingView push for the non-futures tape items (plan P8.28). Run: node --test test/tv.live.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tvIngest, tvOverlay, tvMarket, tvHealth } from '../src/tv.js';

const SYM = JSON.parse(readFileSync(new URL('../config/symbols.json', import.meta.url)));
const LABELS = new Map(SYM.items.filter(i => i.tv || ((!i.set || i.set === 'main') && i.kind === 'fut')).map(i => [i.label, i.kind]));
const NOW = Date.parse('2026-11-18T15:00:00Z');
const quote = (p, pv, t) => { const o = { p: +p.toFixed(4), t }; if (pv) { o.c = +(p - pv).toFixed(4); o.pc = +((p - pv) / pv * 100).toFixed(3); } return o; };

function mkEnv() {
  const st = { row: null };
  return { st, env: { TV_SECRET: 's3', DB: { prepare: () => ({ bind: (...a) => ({ run: async () => { st.row = a[0]; } }), first: async () => (st.row ? { body: st.row } : null) }) } } };
}
const post = (env, q, over = {}) => tvIngest({ text: async () => JSON.stringify({ s: 's3', v: 1, ts: NOW, lag: 3000, q, ...over }) }, env, LABELS, NOW);

test('the flag list: VIX and VIXEQ are never pushable; yields, DXY, MOVE, FX and the ETFs are', () => {
  for (const l of ['USD02Y', 'USD10Y', 'USD30Y', 'DXY', 'MOVE', 'USDJPY', 'TLT', 'HYG', 'XLK', 'SPY', 'ES1!', 'CL1!']) assert.ok(LABELS.has(l), l);
  for (const l of ['VIX', 'VIXEQ']) assert.equal(LABELS.has(l), false, l);
  assert.equal(LABELS.get('ES1!'), 'fut'); assert.equal(LABELS.get('USD10Y'), 'yield'); assert.equal(LABELS.get('XLK'), 'etf');
});

test('a non-future is accepted with a recent bar time; futures still need none', async () => {
  const { env, st } = mkEnv();
  const r = await post(env, { 'USD10Y': [4.12, 4.1, NOW - 30000], 'DXY': [99.5, 99.2, NOW - 60000], 'ES1!': [6800, 6790] });
  assert.equal(r.status, 200); assert.equal(r.out.n, 3); assert.deepEqual(r.out.late, []); assert.deepEqual(r.out.rejected, []);
  assert.deepEqual(Object.keys(JSON.parse(st.row).q).sort(), ['DXY', 'ES1!', 'USD10Y']);
});

test('a non-future without a bar time, or with one from the future, is refused', async () => {
  const { env } = mkEnv();
  const r = await post(env, { 'ES1!': [6800, 6790], 'DXY': [99.5, 99.2], 'MOVE': [90, 89, NOW + 5 * 60000] });
  assert.equal(r.status, 200); assert.equal(r.out.n, 1);
  assert.ok(r.out.rejected.some(x => x.startsWith('DXY') && x.includes('bar time')));
  assert.ok(r.out.rejected.some(x => x.startsWith('MOVE') && x.includes('future')));
});

test('a stale bar is listed as late and not stored as live: 3 minutes for yields/DXY/FX, 10 for ETFs', async () => {
  const { env, st } = mkEnv();
  const r = await post(env, { 'ES1!': [6800, 6790], 'USD30Y': [4.7, 4.69, NOW - 4 * 60000], 'TLT': [92, 91.5, NOW - 8 * 60000], 'IEF': [95, 94.8, NOW - 11 * 60000], 'USDJPY': [155, 154.5, NOW - 2 * 60000] });
  assert.deepEqual(r.out.late.sort(), ['IEF', 'USD30Y']);
  assert.deepEqual(Object.keys(JSON.parse(st.row).q).sort(), ['ES1!', 'TLT', 'USDJPY']);
  assert.deepEqual(tvHealth(JSON.parse(st.row), env, NOW).late.sort(), ['IEF', 'USD30Y']);
});

test('a push where only the closed-market items are late is stored (it clears older live values), not refused', async () => {
  const { env, st } = mkEnv();
  const r = await post(env, { 'TLT': [92, 91.5, NOW - 3 * 3600e3] });
  assert.equal(r.status, 200); assert.equal(r.out.n, 0); assert.deepEqual(r.out.late, ['TLT']);
  assert.deepEqual(JSON.parse(st.row).q, {});
  assert.equal((await post(env, {})).status, 400, 'an empty push is still an error');
});

test('a yield sent x10 (41.2 for 4.12) is refused, not rescaled; a 30% jump is still dropped', async () => {
  const { env } = mkEnv();
  const r = await post(env, { 'ES1!': [6800, 6790], 'USD10Y': [41.2, 41.0, NOW - 1000], 'USDJPY': [220, 155, NOW - 1000] });
  assert.equal(r.out.n, 1);
  assert.ok(r.out.rejected.some(x => x.startsWith('USD10Y') && x.includes('too big')));
  assert.ok(r.out.rejected.some(x => x.startsWith('USDJPY') && x.includes('over 30%')));
});

test('v2 callers that pass a Set of future labels keep working', async () => {
  const { env } = mkEnv();
  const r = await tvIngest({ text: async () => JSON.stringify({ s: 's3', v: 1, ts: NOW, lag: 1000, q: { 'ES1!': [6800, 6790], 'DXY': [99, 98, NOW] } }) }, env, new Set(['ES1!']), NOW);
  assert.equal(r.out.n, 1); assert.ok(r.out.rejected[0].startsWith('DXY'));
});

test('a pushed yield replaces the end-of-day Treasury value: no prior-close flag, no percent change, live', () => {
  const eod = { label: 'USD02Y', kind: 'yield', src: 'treasury:2 Yr', cls: 'prior', p: 3.95, c: 0.02, t: Date.parse('2026-11-17T00:00:00Z'), f: NOW - 3600e3, stale: true, grp: 'RATES' };
  const tv = { f: NOW - 20000, ts: NOW - 25000, lag: 4000, q: { USD02Y: [3.99, 3.95] } };
  const o = tvOverlay(eod, tv, NOW, quote);
  assert.equal(o.p, 3.99); assert.equal(o.c, 0.04); assert.equal(o.live, true); assert.equal(o.src, 'tv'); assert.equal(o.grp, 'RATES');
  assert.equal('cls' in o, false); assert.equal('stale' in o, false); assert.equal('pc' in o, false);
  const etf = tvOverlay({ label: 'TLT', kind: 'etf', p: 90, pc: 0.1 }, { ...tv, q: { TLT: [91, 90] } }, NOW, quote);
  assert.equal(etf.pc, 1.111, 'ETFs keep the percent change');
});

test('a late symbol is left exactly as built, even when the rest of the push is live', () => {
  const body = JSON.stringify({ items: [{ label: 'TLT', kind: 'etf', p: 90, src: 'yahoo:TLT' }, { label: 'XLK', kind: 'etf', p: 300, pc: 0.5, name: 'Technology' }] });
  const tv = { f: NOW - 10000, ts: NOW - 12000, lag: 2000, q: { XLK: [301, 300] }, late: ['TLT'] };
  const j = JSON.parse(tvMarket(body, tv, NOW, quote));
  assert.equal(j.items[0].src, 'yahoo:TLT'); assert.equal(j.items[0].live, undefined);
  assert.equal(j.items[1].live, true); assert.equal(j.items[1].name, 'Technology'); assert.equal(j.items[1].p, 301);
});

// ---- end to end through the Worker: /market and /sectors ----
const tmp = mkdtempSync(join(tmpdir(), 'worker-tvlive-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));

async function worker(tag, push, start = NOW) {   // tv.js keeps a 10 s memo of the D1 row across imports, so each end-to-end test starts its clock well after the last one

  const realNow = Date.now, realFetch = globalThis.fetch;
  let clock = start; Date.now = () => clock;
  const calls = [];
  globalThis.fetch = async u => {
    u = String(u.url || u); calls.push(u);
    const m = /chart\/([^?]+)/.exec(u);
    if (m) {
      const sym = decodeURIComponent(m[1]);
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 99, regularMarketTime: Math.floor(clock / 1000) - 900, shortName: sym.endsWith('=F') ? 'Future ' + sym : undefined } }] } }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => {} }), first: async () => ({ body: JSON.stringify(push()) }) }) } };
  const { default: w } = await import(pathToFileURL(ix).href + '?' + tag);
  const get = async path => (await w.fetch(new Request('https://x.workers.dev' + path), env, { waitUntil() {}, passThroughOnException() {} })).json();
  return { get, calls, adv: ms => { clock += ms; }, done: () => { Date.now = realNow; globalThis.fetch = realFetch; } };
}

test('end to end: live yields, DXY, MOVE, USDJPY and bond ETFs on /market; VIX untouched; live items cost no Yahoo call', async () => {
  const h = await worker('e2e-market', () => ({ f: Date.now() - 5000, ts: Date.now() - 6000, lag: 2500, rej: [], late: ['HYG'], w: {},
    q: { 'ES1!': [6800, 6790], USD10Y: [4.12, 4.1], USD02Y: [3.99, 3.95], DXY: [99.5, 99.2], MOVE: [88, 90], USDJPY: [155.2, 154.9], TLT: [92, 91.5] } }));
  try {
    await h.get('/market');                       // first build fills the cache from Yahoo
    h.adv(61000);
    const before = h.calls.length;
    const j = await h.get('/market');
    const by = Object.fromEntries(j.items.map(i => [i.label, i]));
    for (const l of ['USD10Y', 'USD02Y', 'DXY', 'MOVE', 'USDJPY', 'TLT', 'ES1!']) { assert.equal(by[l].live, true, l); assert.equal(by[l].src, 'tv', l); }
    assert.equal(by.USD02Y.p, 3.99); assert.equal(by.USD02Y.cls, undefined); assert.equal(by.USD10Y.pc, undefined);
    for (const l of ['VIX', 'VIXEQ', 'HYG', 'IEF']) assert.notEqual(by[l].live, true, l + ' stays on its normal feed');
    const asked = h.calls.slice(before).filter(u => u.includes('finance.yahoo.com')).map(u => decodeURIComponent(/chart\/([^?]+)/.exec(u)[1]));
    for (const sym of ['^TNX', 'DX-Y.NYB', '^MOVE', 'JPY=X', 'TLT']) assert.equal(asked.includes(sym), false, sym + ' needed no Yahoo call');
    assert.ok(asked.includes('^VIX') || asked.includes('HYG'), 'the items that are not live are still fetched: ' + asked.join());
  } finally { h.done(); }
});

test('end to end: /sectors shows live ETFs from the push and leaves the rest alone', async () => {
  const h = await worker('e2e-sectors', () => ({ f: Date.now() - 5000, ts: Date.now() - 6000, lag: 2500, rej: [], late: ['XLE'], w: {}, q: { XLK: [301, 300], SPY: [690, 688] } }), NOW + 600000);
  try {
    const j = await h.get('/sectors?fresh');
    const by = Object.fromEntries(j.items.map(i => [i.label, i]));
    assert.equal(by.XLK.live, true); assert.equal(by.XLK.p, 301); assert.equal(by.XLK.pc, 0.333);
    assert.equal(by.SPY.live, true);
    assert.notEqual(by.XLE.live, true);
  } finally { h.done(); }
});
