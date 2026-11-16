// FRED API path for the official actuals: parser, URL, and the numbers that come out (same expectations as the CSV path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFredJson, parseFredCsv, fredApiUrl, applyOfficial, SERIES } from '../src/official.js';

const api = obs => JSON.stringify({ realtime_start: '2026-11-16', observations: obs.map(([date, value]) => ({ realtime_start: '2026-11-16', realtime_end: '2026-11-16', date, value })) });

test('parseFredJson reads observations, skips "." and blanks, and matches the CSV parser', () => {
  const m = parseFredJson(api([['2026-08-01', '159000.0'], ['2026-09-01', '.'], ['2026-10-01', '159150'], ['2026-11-01', '']]));
  assert.deepEqual([...m], [['2026-08-01', 159000], ['2026-10-01', 159150]]);
  assert.deepEqual([...parseFredCsv('observation_date,PAYEMS\n2026-08-01,159000.0\n2026-09-01,.\n2026-10-01,159150\n')], [['2026-08-01', 159000], ['2026-10-01', 159150]]);
});

test('parseFredJson turns an API error body into a readable error without the key', () => {
  assert.throws(() => parseFredJson(JSON.stringify({ error_code: 400, error_message: 'Bad Request.  The value for variable api_key is not registered.' })), /FRED API: Bad Request/);
  assert.throws(() => parseFredJson('<html>520</html>'), /not JSON/);
  assert.throws(() => parseFredJson('null'), /unexpected payload/);
});

test('fredApiUrl asks the observations endpoint for JSON from the start date, with the key encoded', () => {
  const u = new URL(fredApiUrl('CES0500000003', 'ab&cd', '2025-08-03'));
  assert.equal(u.host, 'api.stlouisfed.org'); assert.equal(u.pathname, '/fred/series/observations');
  assert.equal(u.searchParams.get('series_id'), 'CES0500000003'); assert.equal(u.searchParams.get('api_key'), 'ab&cd');
  assert.equal(u.searchParams.get('file_type'), 'json'); assert.equal(u.searchParams.get('observation_start'), '2025-08-03');
});

test('actuals computed from API series: claims, payrolls and unemployment fill blank rows', () => {
  const M = {
    ICSA: parseFredJson(api([['2026-11-07', '221000'], ['2026-11-14', '228000']])),
    PAYEMS: parseFredJson(api([['2026-09-01', '159000'], ['2026-10-01', '159150']])),
    UNRATE: parseFredJson(api([['2026-09-01', '4.4'], ['2026-10-01', '4.5']])),
  };
  const NOW = Date.UTC(2026, 10, 20, 15, 0), T = (d, h) => Date.parse(`${d}T${h}:00Z`);
  const ev = [
    { k: 'nfp', r: 'nfp', d: '2026-11-06', pd: 'Oct', t: T('2026-11-06', '13:30'), ac: null, pv: null, title: 'NFP' },
    { k: 'nfp', r: 'unemp', d: '2026-11-06', pd: 'Oct', t: T('2026-11-06', '13:30'), ac: null, pv: null, title: 'UR' },
    { k: 'claims', r: 'main', d: '2026-11-19', t: T('2026-11-19', '13:30'), ac: null, pv: null, title: 'Claims' },
  ];
  const o = applyOfficial(ev, M, NOW);
  assert.equal(o.n, 3);
  assert.match(ev[0].ac, /150/); assert.match(ev[1].ac, /4\.5/); assert.match(ev[2].ac, /228/);
  assert.equal(ev[2].sr.ac, 'FRED');
});

test('every series the Worker asks for has a SPEC row (7 requests a poll)', () => {
  assert.equal(SERIES.length, 7);
});
