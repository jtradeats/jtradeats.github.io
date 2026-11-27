// P8.11: ?fresh=1 on /market, /calendar, /curve and /feed (a manual refresh on the page). It skips the in-memory reuse for that request, still honours the failure back-off,
// the per-item reuse times and the KV throttles, adds no KV write, and answers with Cache-Control: no-store. Run: node --test test/fresh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'worker-fresh-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));
const { default: worker } = await import(pathToFileURL(ix).href);
const F = await import(pathToFileURL(join(tmp, 'src', 'feed.js')).href);
F._useRunner(async (html, attach) => {   // the real parser handlers, driven from simple markup (no HTMLRewriter in Node)
  const H = {}; attach({ on(sel, h) { H[sel] = h; return this; } });
  const el = attrs => ({ getAttribute: k => attrs[k] ?? null, onEndTag() {} });
  for (const blk of html.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const id = /data-post="([^"]+)"/.exec(blk)[1], t = /datetime="([^"]+)"/.exec(blk)[1], txt = /<text>([\s\S]*?)<\/text>/.exec(blk)[1];
    H['[data-post]'].element(el({ 'data-post': id })); H['.tgme_widget_message_text'].element(el({})); H['.tgme_widget_message_text'].text({ text: txt });
    H['.tgme_widget_message_date time'].element(el({ datetime: t }));
  }
});

// A price inside each symbol's V1 range (symbols.json "range", P8.16): the Worker treats an out-of-range price as a failed source, and an item with no good value yet is asked again
// on every build, so a single made-up price (the old fixed 100) made ten items (VIX, TYX, the futures) refetch on a refresh and hid what this test is about.
const RANGE = {};
for (const it of JSON.parse(readFileSync(new URL('../config/symbols.json', import.meta.url))).items) for (const [src, sym] of it.chain || []) if (src === 'yahoo' && it.range) RANGE[sym] = (it.range[0] + it.range[1]) / 2;
const priceOf = u => { const m = /\/chart\/([^?]+)/.exec(u); const mid = m && RANGE[decodeURIComponent(m[1])]; return mid || 100; };
let clock = Date.parse('2026-11-24T15:00:00Z'), calls = [], tgStatus = 200, tgN = 1;
const count = host => calls.filter(u => u.includes(host)).length;
const tgPage = ch => '<html>' + [1, 2, 3].map(i => `<div class="tgme_widget_message_wrap"><div data-post="${ch}/${tgN * 10 + i}"><text>headline ${tgN}-${i}</text><time datetime="${new Date(clock - i * 1000).toISOString()}"></time></div></div>`).join('') + '</html>';
const fetchMock = async req => {
  const u = String(req.url || req); calls.push(u);
  if (u.includes('finance.yahoo.com')) return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: priceOf(u) * (1 + calls.length * 1e-6), chartPreviousClose: priceOf(u), regularMarketTime: Math.floor(clock / 1000), shortName: 'X' } }] } }), { status: 200 });
  if (u.includes('t.me/s/')) return tgStatus === 200 ? new Response(tgPage(/s\/([A-Za-z]+)/.exec(u)[1]), { status: 200 }) : new Response('x', { status: tgStatus });
  if (u.includes('home.treasury.gov') || u.includes('treasury.gov')) return new Response('Date,1 Mo,2 Yr,10 Yr\n"11/20/2026",4.0,3.6,4.1\n"11/23/2026",4.0,3.61,4.11', { status: 200 });
  return new Response('no', { status: 404 });
};
const kv = () => { const store = {}, puts = []; return { store, puts, get: async (k, t) => (k in store ? (t === 'json' ? JSON.parse(store[k]) : store[k]) : null), put: async (k, v) => { puts.push(k); store[k] = String(v); } }; };
async function get(path, env, advance = 0) {
  clock += advance; const realNow = Date.now, realFetch = globalThis.fetch, pending = [];
  Date.now = () => clock; globalThis.fetch = fetchMock;
  try {
    const r = await worker.fetch(new Request('https://x.workers.dev' + path), env, { waitUntil: p => pending.push(p), passThroughOnException() {} });
    const text = await r.text(); await Promise.all(pending);
    return { status: r.status, cc: r.headers.get('Cache-Control'), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}

test('/market: a fresh request rebuilds at once (after 5 s), the plain one reuses the answer; no extra KV write; the items keep their own 30 s reuse', async () => {
  const env = { MARKET_KV: kv() };
  const a = await get('/market', env); assert.equal(a.status, 200);
  const puts0 = env.MARKET_KV.puts.length, n0 = count('yahoo');
  assert.ok(n0 > 0 && puts0 >= 1, 'the first build fetched and saved the snapshot');
  const b = await get('/market', env, 4000); assert.equal(count('yahoo'), n0, 'a plain request inside 30 s reuses the answer');
  const c = await get('/market?fresh=1', env, 1000);   // 5 s after the build
  assert.equal(c.cc, 'no-store'); assert.equal(c.status, 200);
  assert.notEqual(JSON.parse(c.text).updated === JSON.parse(a.text).updated && c.text === a.text, true, 'a rebuilt answer, not the stored text');
  assert.equal(env.MARKET_KV.puts.length, puts0, 'a manual refresh adds no KV write');
  assert.equal(count('yahoo'), n0, 'items are still reused for their own 30 s, so a refresh never fans out into many upstream calls');
  const d = await get('/market?fresh=1', env, 31000);   // past the items' reuse: now they are fetched again
  assert.ok(count('yahoo') > n0); assert.equal(env.MARKET_KV.puts.length, puts0);
  const e0 = count('yahoo'); await get('/market?fresh=1', env, 1000);   // inside 5 s of the last build: honoured at most every 5 s
  assert.equal(count('yahoo'), e0);
  const f = await get('/market?fresh=0', env, 100); assert.equal(f.cc, 'no-store'); // /market is always no-store; fresh=0 is a plain request
});

test('/curve: fresh skips the 15-minute reuse (at most every 30 s), waits for the new answer and sends no-store; a plain request keeps public caching', async () => {
  const env = { MARKET_KV: kv() };
  const a = await get('/curve', env); assert.equal(a.status, 200); assert.equal(a.cc, 'public, max-age=60');
  const t0 = count('treasury.gov'); assert.ok(t0 > 0);
  await get('/curve', env, 60000); assert.equal(count('treasury.gov'), t0, 'plain: reused for 15 minutes');
  await get('/curve?fresh=1', env, 1000);   // 61 s after the build
  assert.ok(count('treasury.gov') > t0, 'fresh: fetched again');
  const t1 = count('treasury.gov'), r = await get('/curve?fresh=1', env, 5000);
  assert.equal(count('treasury.gov'), t1, 'inside 30 s of the last build it is not fetched again'); assert.equal(r.cc, 'no-store');
});

test('/feed: fresh polls Telegram again after 3 s instead of 10 s; a failure still backs off', async () => {
  const env = {}; F._useRunner; tgN = 1;
  const a = await get('/feed', env); assert.equal(a.status, 200);
  const t0 = count('t.me/s/'); assert.ok(t0 >= 1);
  tgN = 2; await get('/feed', env, 4000); assert.equal(count('t.me/s/'), t0, 'plain: reused for 10 s');
  const f = await get('/feed?fresh=1', env, 100); assert.ok(count('t.me/s/') > t0, 'fresh: polled again'); assert.equal(f.cc, 'no-store');
  const t1 = count('t.me/s/'); await get('/feed?fresh=1', env, 1000); assert.equal(count('t.me/s/'), t1, 'fresh inside 3 s: no second poll');
  tgStatus = 429; await get('/feed?fresh=1', env, 4000);   // the poll fails with a 429
  const t2 = count('t.me/s/'); assert.ok(t2 > t1);
  await get('/feed?fresh=1', env, 5000); await get('/feed?fresh=1', env, 5000);
  assert.equal(count('t.me/s/'), t2, 'after a 429 a manual refresh does not ask again inside the back-off (60 s)');
  tgStatus = 200;
});

test('/calendar: fresh skips the 10 s reuse (at most every 3 s) and sends no-store; the answer is rebuilt', async () => {
  const env = { MARKET_KV: kv() };
  const a = await get('/calendar', env); assert.equal(a.status, 200); assert.equal(a.cc, 'no-store');
  const same = await get('/calendar', env, 4000); assert.equal(same.text, a.text, 'plain: the 10 s memo');
  const f = await get('/calendar?fresh=1', env, 100);   // 4.1 s after the build
  assert.equal(f.status, 200); assert.equal(f.cc, 'no-store');
  assert.notEqual(f.text, a.text, 'fresh: rebuilt (the answer carries the build time)');
  const g = await get('/calendar?fresh=1', env, 1000); assert.equal(g.text, f.text, 'inside 3 s the last build is reused');
});
