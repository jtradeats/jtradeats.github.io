// Yield curve (plan P6). Run: node --test worker/test/curve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenorKey, parseTreasuryCsv, normalize, buildCurve, crossCheck, stateOf, CURVE_TENORS, KEEP } from '../src/curve.js';
import { parseFredCsv } from '../src/official.js';

const HEAD = 'Date,1 Mo,1.5 Month,2 Mo,3 Mo,4 Mo,6 Mo,1 Yr,2 Yr,3 Yr,5 Yr,7 Yr,10 Yr,20 Yr,30 Yr';
const COLS = HEAD.split(',').slice(1);
const mdy = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
// a row from { '3 Mo': 3.95, '2 Yr': 3.6, ... }; missing columns are "N/A"
const row = (iso, o) => `"${mdy(iso)}",` + COLS.map(c => (o[c] == null ? 'N/A' : o[c].toFixed(2))).join(',');
const base = { '1 Mo': 4.0, '3 Mo': 3.95, '6 Mo': 3.85, '1 Yr': 3.7, '2 Yr': 3.6, '3 Yr': 3.62, '5 Yr': 3.75, '7 Yr': 3.95, '10 Yr': 4.1, '20 Yr': 4.5, '30 Yr': 4.7 };
const shift = (b, add) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v + (add[k] ?? add.all ?? 0)]));

// ---- a fixed history with the lookback dates the build looks for (latest Fri 13 Nov 2026) ----
function history() {
  const rows = [];
  // weekdays from 2025-10-01 to 2026-11-13: slow drift so no two sessions are equal, then hand-set the dates we assert on
  for (let t = Date.parse('2025-10-01T00:00:00Z'), i = 0; t <= Date.parse('2026-11-13T00:00:00Z'); t += 864e5) {
    const dt = new Date(t), dow = dt.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    rows.push([dt.toISOString().slice(0, 10), shift(base, { all: Math.round((i++ % 30) - 15) / 100 })]);
  }
  const set = (iso, o) => { const r = rows.find(x => x[0] === iso); assert.ok(r, iso); r[1] = o; };
  set('2026-11-13', { ...base, '2 Yr': 3.6, '10 Yr': 4.1, '30 Yr': 4.7, '3 Mo': 3.95, '5 Yr': 3.75 });
  set('2026-11-12', { ...base, '2 Yr': 3.57, '10 Yr': 4.12, '30 Yr': 4.7, '3 Mo': 3.95, '5 Yr': 3.76 });
  set('2026-11-06', { ...base, '2 Yr': 3.5, '10 Yr': 4.05, '30 Yr': 4.62, '3 Mo': 3.9, '5 Yr': 3.7 });
  set('2026-10-13', { ...base, '2 Yr': 3.7, '10 Yr': 4.0, '30 Yr': 4.55, '3 Mo': 4.0, '5 Yr': 3.8 });
  set('2025-11-13', { ...base, '2 Yr': 3.9, '10 Yr': 4.2, '30 Yr': 4.8, '3 Mo': 4.1, '5 Yr': 3.95 });
  return rows;
}
const csv = rows => [HEAD, ...rows.map(([d, o]) => row(d, o))].join('\n');
const FRED_OK = parseFredCsv('observation_date,T10Y2Y\n2026-11-12,0.55\n2026-11-13,0.50');

test('tenor names are read by header, including the 1.5 Month column and either spelling', () => {
  assert.equal(tenorKey('2 Yr'), '2Y');
  assert.equal(tenorKey('1 Mo'), '1M');
  assert.equal(tenorKey('1.5 Month'), '1.5M');
  assert.equal(tenorKey('30 Yr'), '30Y');
  assert.equal(tenorKey('Date'), null);
  assert.equal(tenorKey('10 Year'), '10Y');
});

test('CSV parsing: quoted fields, N/A, blank lines, columns in any order and a missing tenor', () => {
  const text = 'Date,30 Yr,2 Yr,10 Yr\n"11/13/2026",4.70,3.60,4.10\n\n"11/12/2026",N/A,3.57,4.12\n';
  const rows = parseTreasuryCsv(text);
  assert.equal(rows.length, 2);
  const S = normalize(rows);
  assert.deepEqual(S.map(s => s.d), ['2026-11-12', '2026-11-13']);
  assert.deepEqual(S[0].y, { '2Y': 3.57, '10Y': 4.12 }, 'N/A is dropped, not zero');
  assert.deepEqual(S[1].y, { '30Y': 4.7, '2Y': 3.6, '10Y': 4.1 });
});

test('dates are sorted, de-duplicated, and joined across two yearly files', () => {
  const rows = parseTreasuryCsv(csv(history()));
  const S = normalize([...rows.slice(100), ...rows]);   // overlap on purpose
  assert.equal(new Set(S.map(s => s.d)).size, S.length);
  for (let i = 1; i < S.length; i++) assert.ok(S[i - 1].d < S[i].d);
});

test('levels, spreads and changes against the previous day, 1 week, 1 month and 1 year', () => {
  const c = buildCurve(parseTreasuryCsv(csv(history())), FRED_OK, Date.parse('2026-11-13T22:00:00Z'));
  assert.equal(c.asof, '2026-11-13');
  assert.deepEqual(c.dates, { d1: '2026-11-12', w1: '2026-11-06', m1: '2026-10-13', y1: '2025-11-13' });
  const y2 = c.yields.find(y => y.k === '2Y');
  assert.deepEqual({ v: y2.v, d1: y2.d1, w1: y2.w1, m1: y2.m1, y1: y2.y1 }, { v: 3.6, d1: 3, w1: 10, m1: -10, y1: -30 });
  const y10 = c.yields.find(y => y.k === '10Y');
  assert.deepEqual({ d1: y10.d1, w1: y10.w1, m1: y10.m1, y1: y10.y1 }, { d1: -2, w1: 5, m1: 10, y1: -10 });
  const s = Object.fromEntries(c.spreads.map(x => [x.id, x]));
  // 10Y-2Y: now 50 bp; 12 Nov 55; 6 Nov 55; 13 Oct 30; 13 Nov 2025 30
  assert.deepEqual({ bp: s['10s2s'].bp, d1: s['10s2s'].d1, w1: s['10s2s'].w1, m1: s['10s2s'].m1, y1: s['10s2s'].y1 }, { bp: 50, d1: -5, w1: -5, m1: 20, y1: 20 });
  assert.equal(s['10s2s'].state, 'steepening');
  // 30Y-10Y: now 60; 13 Oct 55 -> +5 = steepening at the threshold
  assert.equal(s['30s10s'].bp, 60); assert.equal(s['30s10s'].m1, 5); assert.equal(s['30s10s'].state, 'steepening');
  // 10Y-3M: 4.10-3.95 = 15; 13 Oct 4.00-4.00 = 0 -> +15
  assert.equal(s['10y3m'].bp, 15); assert.equal(s['10y3m'].m1, 15);
  // 30Y-5Y: 4.70-3.75 = 95; 13 Oct 4.55-3.80 = 75 -> +20
  assert.equal(s['30s5s'].bp, 95); assert.equal(s['30s5s'].m1, 20);
  assert.equal(c.age_days, 0);
});

test('state words: 5 bp over a month is the threshold; inversion is flagged separately', () => {
  assert.equal(stateOf(5), 'steepening'); assert.equal(stateOf(4), 'flat'); assert.equal(stateOf(0), 'flat');
  assert.equal(stateOf(-4), 'flat'); assert.equal(stateOf(-5), 'compressing'); assert.equal(stateOf(null), null);
  const h = history(); h[h.length - 1][1] = { ...base, '2 Yr': 4.3, '10 Yr': 4.1 };   // 2Y above 10Y
  const c = buildCurve(parseTreasuryCsv(csv(h)), null);
  const s = c.spreads.find(x => x.id === '10s2s');
  assert.equal(s.bp, -20); assert.equal(s.inv, true);
});

test('curve view: eleven tenors from 1M to 30Y for today, a month ago and a year ago', () => {
  const c = buildCurve(parseTreasuryCsv(csv(history())), null);
  assert.deepEqual(c.curve.tenors, CURVE_TENORS);
  assert.equal(c.curve.latest.length, 11);
  assert.equal(c.curve.latest[CURVE_TENORS.indexOf('10Y')], 4.1);
  assert.equal(c.curve.m1[CURVE_TENORS.indexOf('10Y')], 4.0);
  assert.equal(c.curve.y1[CURVE_TENORS.indexOf('10Y')], 4.2);
});

test('history keeps at most KEEP sessions, newest last, and carries 2Y, 10Y and 30Y', () => {
  const c = buildCurve(parseTreasuryCsv(csv(history())), null);
  assert.ok(c.hist.dates.length <= KEEP && c.hist.dates.length === c.sessions);
  assert.equal(c.hist.dates.at(-1), '2026-11-13');
  assert.equal(c.hist.y10.at(-1), 4.1); assert.equal(c.hist.y2.at(-1), 3.6); assert.equal(c.hist.y30.at(-1), 4.7);
  assert.equal(c.hist.y2.length, c.hist.dates.length);
});

test('a lookback before the start of the data is null, not the first session', () => {
  const h = history().slice(-60);   // about three months
  const c = buildCurve(parseTreasuryCsv(csv(h)), null);
  assert.equal(c.dates.y1, null);
  assert.equal(c.yields.find(y => y.k === '10Y').y1, null);
  assert.equal(c.curve.y1, null);
  assert.equal(c.spreads[0].y1, null);
});

test('a missing tenor does not break the others (no 3M today: that spread is null, the rest stand)', () => {
  const h = history(); const last = h[h.length - 1][1]; delete last['3 Mo'];
  const c = buildCurve(parseTreasuryCsv(csv(h)), null);
  assert.equal(c.spreads.find(x => x.id === '10y3m').bp, null);
  assert.equal(c.spreads.find(x => x.id === '10s2s').bp, 50);
  assert.ok(!c.yields.some(y => y.k === '3M'));
});

test('cross-check against FRED T10Y2Y: ok, differs, pending (FRED behind) and unavailable', () => {
  const last = { d: '2026-11-13', y: { '2Y': 3.6, '10Y': 4.1 } };
  assert.deepEqual(crossCheck(last, FRED_OK), { id: 'T10Y2Y', status: 'ok', ours: 50, fred: 50, diffBp: 0 });
  assert.equal(crossCheck(last, parseFredCsv('observation_date,T10Y2Y\n2026-11-13,0.44')).status, 'differs');
  assert.equal(crossCheck(last, parseFredCsv('observation_date,T10Y2Y\n2026-11-13,0.51')).status, 'ok', '1 bp is rounding, not a disagreement');
  assert.equal(crossCheck(last, parseFredCsv('observation_date,T10Y2Y\n2026-11-12,0.55\n2026-11-13,.')).status, 'pending');
  assert.equal(crossCheck(last, null).status, 'unavailable');
  assert.equal(crossCheck({ d: '2026-11-13', y: { '10Y': 4.1 } }, FRED_OK).status, 'unavailable');
});

test('too little data is an error, not an empty card', () => {
  assert.throws(() => buildCurve(parseTreasuryCsv(HEAD + '\n' + row('2026-11-13', base)), null), /fewer than 2/);
});
