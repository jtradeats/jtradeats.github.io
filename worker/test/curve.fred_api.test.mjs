// /curve and the tape's FRED fallback use FRED's API when the secret FRED_KEY is set (the keyless CSV is refused from Cloudflare). Run: node --test test/curve.fred_api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// index.js imports ../config/*.json the way Wrangler's bundler allows; plain Node wants an import attribute, so the test runs a temporary copy with it added.
const tmp = mkdtempSync(join(tmpdir(), 'worker-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));

const HEAD = 'Date,1 Mo,1.5 Month,2 Mo,3 Mo,4 Mo,6 Mo,1 Yr,2 Yr,3 Yr,5 Yr,7 Yr,10 Yr,20 Yr,30 Yr';
const mdy = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const days = [];
for (let t = Date.parse('2025-10-01T00:00:00Z'); t <= Date.parse('2026-11-13T00:00:00Z'); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const CSV = [HEAD, ...days.map(d => `"${mdy(d)}",4.0,N/A,4.0,3.95,N/A,3.85,3.7,3.6,3.62,3.75,3.95,4.1,4.5,4.7`)].join('\n');

const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url.url || url); calls.push(u);
  if (u.includes('stlouisfed.org/fred/series/observations')) return new Response(JSON.stringify({ observations: [{ date: '2026-11-12', value: '0.50' }, { date: '2026-11-13', value: '0.50' }] }), { status: 200 });
  if (u.includes('fredgraph.csv')) return new Response('blocked', { status: 520 });
  return new Response(CSV, { status: 200 });   // the Treasury CSV
};
const { default: worker } = await import(pathToFileURL(ix).href);
const ctx = { waitUntil() {}, passThroughOnException() {} };

test('/curve with FRED_KEY: the T10Y2Y cross-check goes to the API, never the keyless CSV, and is not "unavailable"', async () => {
  const r = await worker.fetch(new Request('https://x.workers.dev/curve'), { FRED_KEY: 'TESTKEY' }, ctx);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(calls.some(u => u.includes('api.stlouisfed.org') && u.includes('series_id=T10Y2Y') && u.includes('api_key=TESTKEY')));
  assert.ok(!calls.some(u => u.includes('fredgraph.csv')));
  assert.notEqual(j.check.status, 'unavailable', JSON.stringify(j.check));
});
