import test from 'node:test';
import assert from 'node:assert/strict';
import { heatProbe, _reset, tokensAfter, listAssets, sameSite, scanBundle, countNeedle } from '../src/heat_probe.js';

const html = `<html><head><title>S&P 500 Map</title>
<link rel="modulepreload" href="/assets/chunk-a.js">
<script src="https://www.googletagmanager.com/gtm.js"></script>
<script src="/assets/map.abc123.js"></script>
<script src="https://assets.finviz.com/app.js"></script>
<script type="application/json" id="route-init-data">{"a":1}</script>
</head><body>x</body></html>`;
const mapJs = 'x=fetch("/api/map_perf.ashx?t="+t);y="/api/map_layout.ashx?t=sec";const M={sec:"S&P 500",sec_ndx:"Nasdaq 100",sec_all:"All",themes:"Themes"};';
const perf = '{"nodes":{"AAPL":1.2,"MSFT":-0.4,"NVDA":3.1},"version":7}';

function mockFetch(map) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    for (const [k, v] of Object.entries(map)) if (u.includes(k)) {
      const body = typeof v === 'function' ? v(opts) : v;
      return new Response(body, { status: body === null ? 404 : 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('nope', { status: 404 });
  };
}

test('helpers', () => {
  assert.deepEqual(tokensAfter(mapJs, '/api/'), ['/api/map_perf.ashx?t=', '/api/map_layout.ashx?t=sec']);
  assert.equal(countNeedle(perf, '":'), 5);   // 3 entries + the two wrapper keys
  const a = listAssets(html);
  assert.equal(a.scripts.length, 4);
  assert.deepEqual(a.preloads, ['/assets/chunk-a.js']);
  assert.equal(sameSite('/assets/map.abc123.js'), true);
  assert.equal(sameSite('https://www.googletagmanager.com/gtm.js'), false);
  assert.equal(sameSite('https://evilfinviz.com/x.js'), false);
  const pad = 'a'.repeat(3000);
  const s = scanBundle(mapJs.replace('themes:', pad + 'themes:'));   // far enough apart that the windows differ
  assert.ok(s.names.sec_ndx);
  assert.ok(s.names.themes || s.names.Themes);
  assert.equal(s.mapPerf.length, 1);
});

test('page step reads the page and the map script first', async () => {
  _reset();
  mockFetch({ 'map.ashx': html, 'map.abc123.js': mapJs, 'app.js': 'z=1' });
  const out = JSON.parse(await heatProbe('https://w/heat-test'));
  assert.equal(out.ok, true);
  assert.equal(out.sameSiteScripts.length, 2);
  assert.equal(out.scanned[0].src.endsWith('map.abc123.js'), true);   // the "map" script is read first
  assert.ok(out.scanned[0].api.includes('/api/map_layout.ashx?t=sec'));
  assert.equal(out.otherScripts.length, 1);
  assert.equal(out.inline[0].id, 'route-init-data');
});

test('rate limit and memo', async () => {
  _reset();
  mockFetch({ 'map.ashx': html, 'map.abc123.js': mapJs, 'app.js': 'z=1' });
  const a = await heatProbe('https://w/heat-test', 1000);
  assert.equal(await heatProbe('https://w/heat-test', 30000), a);                       // same URL within 60 s: same answer
  const b = JSON.parse(await heatProbe('https://w/heat-test?step=data', 5000));         // another URL within 20 s: refused
  assert.equal(b.ok, false);
  const c = JSON.parse(await heatProbe('https://w/heat-test?step=data', 40000));
  assert.equal(c.step, 'data');
});

test('data step summarises each preset and survives a failure', async () => {
  _reset();
  globalThis.fetch = async (url) => String(url).includes('t=fut&') ? new Response('', { status: 404 }) : new Response(perf, { status: 200 });
  const out = JSON.parse(await heatProbe('https://w/heat-test?step=data&t=sec,fut,bad!name'));
  assert.equal(out.results.length, 2);                       // the invalid name is dropped
  assert.equal(out.results[0].approxEntries, 5);
  assert.equal(out.results[1].status, 404);
});

test('uni step reads the TradingView reply and posts the right body', async () => {
  _reset();
  let seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('tradingview')) { seen.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ totalCount: 503, data: [{ s: 'NASDAQ:NVDA', d: ['NVDA', 'NVIDIA', 5e12, 'Electronic Technology', 'Semiconductors', 1.2, 180, 'NASDAQ'] }] }), { status: 200 }); }
    return new Response('{"data":{}}', { status: 200 });
  };
  const out = JSON.parse(await heatProbe('https://w/heat-test?step=uni'));
  assert.equal(out.results.length, 4);
  assert.equal(out.results[1].totalCount, 503);
  assert.deepEqual(seen[1].symbols, { symbolset: ['SYML:SP;SPX'] });
  assert.equal(seen[0].range[1], 5);
});

test('get step only takes finviz api paths', async () => {
  _reset();
  mockFetch({ '/api/x.ashx': '{"a":1}' });
  const bad = JSON.parse(await heatProbe('https://w/heat-test?step=get&path=' + encodeURIComponent('https://evil.com/x')));
  assert.equal(bad.ok, false);
  _reset();
  const bad2 = JSON.parse(await heatProbe('https://w/heat-test?step=get&path=' + encodeURIComponent('/api/../etc')));
  assert.equal(bad2.ok, false);
  _reset();
  const ok = JSON.parse(await heatProbe('https://w/heat-test?step=get&path=' + encodeURIComponent('/api/x.ashx?t=sec')));
  assert.equal(ok.status, 200);
});
