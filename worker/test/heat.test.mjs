import test from 'node:test';
import assert from 'node:assert/strict';
import { heatRoute, _reset, MAPS } from '../src/heat.js';
import { mergeHeat } from '../src/heat_merge.js';

// shapes copied from the 27 Nov probe output
const base = '{"name":"Root","children":[{"name":"Basic Materials","children":[{"name":"Agricultural Inputs","children":[{"name":"CF","description":"CF Industries Holdings Inc","value":17188},{"name":"MOS","description":"Mosaic Company","value":6469}]}]},{"name":"Utilities","children":[{"name":"Regulated Water","children":[{"name":"AWK","description":"American Water Works Co Inc","value":30431}]}]}],"duplicateTickers":0,"hash":"X"}';
const perf = '{"nodes":{"CF":0.651,"MOS":3.404,"AWK":1.622},"additional":{},"subtype":"d1","version":15,"hash":"Y"}';
const themesBase = '{"name":"Root","children":[{"name":"1","children":[{"name":"Artificial Intelligence","children":[{"name":"aicompute","displayName":"Compute","description":"Compute & Acceleration","value":1,"extra":"NVDA,AMD"}]}]}]}';
const themesPerf = '{"nodes":{"aicompute":-1.572},"additional":{},"subtype":"d1","version":15}';
const H = { 'Content-Type': 'application/json' };
const req = q => new Request('https://w/heat' + q);
let calls;
function mock(map) {
  calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    for (const [k, v] of Object.entries(map)) if (String(url).includes(k)) return typeof v === 'function' ? v() : new Response(v, { status: 200 });
    return new Response('nope', { status: 404 });
  };
}

test('friendly names map to the names Finviz really uses; the ignored ones never go upstream', async () => {
  assert.deepEqual(MAPS, { sec: 'sec', ndx: 'sec_ndx', all: 'sec_all', futures: 'futures', themes: 'themes' });
  _reset(); mock({ 'map_perf': perf });
  await heatRoute(req('?t=ndx'), H);
  assert.ok(calls[0].includes('map_perf?t=sec_ndx&st=d1'));
  for (const bad of ['fut', 'thm', 'sec_ndx', '..%2Fx']) assert.equal((await heatRoute(req('?t=' + bad), H)).status, 400);
});

test('perf and base are passed through as text, with source and age; a repeat inside the ttl is not refetched', async () => {
  _reset(); mock({ '/api/maps/base/sec': base, 'map_perf': perf });
  const a = await heatRoute(req('?t=sec&part=base'), H, 1000);
  assert.equal(await a.text(), base); assert.equal(a.headers.get('X-Heat-Source'), 'fresh');
  const b = await heatRoute(req('?t=sec&part=base'), H, 3600e3);
  assert.equal(b.headers.get('X-Heat-Source'), 'memo'); assert.equal(calls.length, 1);
  const c = await heatRoute(req('?t=sec'), H, 1000), d = await heatRoute(req('?t=sec'), H, 30000);
  assert.equal(d.headers.get('X-Heat-Source'), 'memo'); assert.equal(calls.length, 2);
  const e = await heatRoute(req('?t=sec'), H, 50000);   // past 45 s
  assert.equal(e.headers.get('X-Heat-Source'), 'fresh'); assert.equal(calls.length, 3);
});

test('a block page or an error is never passed on as data; the last good copy is served flagged stale, then it gives up', async () => {
  _reset(); mock({ 'map_perf': perf });
  await heatRoute(req('?t=sec'), H, 1000);
  mock({ 'map_perf': '<html>blocked</html>' });
  const s = await heatRoute(req('?t=sec'), H, 60000);
  assert.equal(s.headers.get('X-Heat-Source'), 'stale'); assert.equal(await s.text(), perf);
  await assert.rejects(heatRoute(req('?t=sec'), H, 1000 + 11 * 60e3), /unexpected start/);
  _reset(); mock({ 'map_perf': '<html>blocked</html>' });
  await assert.rejects(heatRoute(req('?t=sec'), H, 1000));
});

test('failure back-off: a second call within 30 s does not hit Finviz again', async () => {
  _reset(); mock({ 'map_perf': perf });
  await heatRoute(req('?t=sec'), H, 1000);
  mock({ 'map_perf': () => new Response('x', { status: 500 }) });
  await heatRoute(req('?t=sec'), H, 60000);            // fails, stale served
  const n = calls.length;
  await heatRoute(req('?t=sec'), H, 70000);            // inside back-off
  assert.equal(calls.length, n);
});

test('merge: size is market cap, colour is % change, sectors survive; unmatched leaves are null', () => {
  const m = mergeHeat(JSON.parse(base), JSON.parse(perf));
  assert.equal(m.leaves, 3); assert.equal(m.matched, 3); assert.equal(m.ok, true);
  const cf = m.tree[0].children[0].children[0];
  assert.deepEqual(cf.value, [17188, 0.651]); assert.equal(cf.desc, 'CF Industries Holdings Inc');
  const half = mergeHeat(JSON.parse(base), { nodes: { CF: 1 } });
  assert.equal(half.ok, false);                          // 1 of 3 matched: wrong pair, page shows a note
  assert.equal(half.tree[0].children[0].children[1].value[1], null);
});

test('merge: themes use displayName for the label and keep the member tickers', () => {
  const m = mergeHeat(JSON.parse(themesBase), JSON.parse(themesPerf));
  const leaf = m.tree[0].children[0].children[0];
  assert.equal(leaf.label, 'Compute'); assert.equal(leaf.members, 'NVDA,AMD'); assert.deepEqual(leaf.value, [1, -1.572]);
});
