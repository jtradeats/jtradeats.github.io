// EIA crude inventories from EIA's own API (plan P8.33). Levels are MADE UP except that their differences reproduce the 12 Nov actual (+4.657M).
import test from 'node:test';
import assert from 'node:assert/strict';
import { eiaApiUrl, parseEiaJson, applyOfficial, obsFor, SPEC, SERIES } from '../src/official.js';
import { newLedger, recordLedger, applyLedger } from '../src/ledger.js';

const api = rows => JSON.stringify({ response: { total: String(rows.length), dateFormat: 'YYYY-MM-DD', frequency: 'weekly', data: rows.map(([period, value]) => ({ period, series: 'WCESTUS1', value: String(value), units: 'MBBL' })) } });
const LV = [['2026-10-30', 424000], ['2026-11-06', 428657], ['2026-11-13', 427100]];
const M = () => ({ 'EIA:WCESTUS1': parseEiaJson(api(LV)) });
const T = (d, h) => Date.parse(`${d}T${h}:00Z`);
const ev = (d, extra = {}) => ({ k: 'eia', r: 'main', d, t: T(d, '15:30'), ac: null, pv: null, dir: 'oil', title: 'Crude Oil Inventories', ...extra });

test('parseEiaJson reads string values, skips blanks, and turns an error body into a readable error', () => {
  assert.deepEqual([...parseEiaJson(api([['2026-11-06', 428657]]))], [['2026-11-06', 428657]]);
  assert.deepEqual([...parseEiaJson(JSON.stringify({ response: { data: [{ period: '2026-11-13', value: '' }, { period: '2026-11-06', value: null }] } }))], []);
  assert.throws(() => parseEiaJson(JSON.stringify({ error: 'API_KEY_INVALID' })), /EIA API: API_KEY_INVALID/);
  assert.throws(() => parseEiaJson('<html>'), /not JSON/);
  assert.throws(() => parseEiaJson('null'), /unexpected payload/);
});

test('eiaApiUrl asks the weekly stocks route for one series, oldest first, with the key encoded', () => {
  const u = new URL(eiaApiUrl('WCESTUS1', 'ab&cd', '2025-08-03'));
  assert.equal(u.host, 'api.eia.gov'); assert.equal(u.pathname, '/v2/petroleum/stoc/wstk/data/');
  assert.equal(u.searchParams.get('api_key'), 'ab&cd'); assert.equal(u.searchParams.get('frequency'), 'weekly');
  assert.equal(u.searchParams.get('facets[series][]'), 'WCESTUS1'); assert.equal(u.searchParams.get('data[0]'), 'value');
  assert.equal(u.searchParams.get('start'), '2025-08-03'); assert.equal(u.searchParams.get('sort[0][direction]'), 'asc');
});

test('obsFor: the Friday before the release (Wednesday, a Thursday after a holiday, Thanksgiving week)', () => {
  const sp = SPEC['eia|main'];
  assert.equal(obsFor({ d: '2026-11-18' }, sp), '2026-11-13');   // Wednesday
  assert.equal(obsFor({ d: '2026-11-12' }, sp), '2026-11-06');   // Thursday (Veterans Day on the Wednesday)
  assert.equal(obsFor({ d: '2026-11-25' }, sp), '2026-11-20');   // Wednesday of Thanksgiving week
});

test('18 Nov: a blank row gets -1.557M from the week-on-week change, tagged EIA, and the previous is the revised 4.657M', () => {
  const e = ev('2026-11-18');
  const o = applyOfficial([e], M(), T('2026-11-19', '04:30'));
  assert.equal(o.n, 1);
  assert.equal(e.ac, '-1.557M'); assert.equal(e.sr.ac, 'EIA');
  assert.equal(e.pv, '4.657M'); assert.equal(e.sr.pv, 'EIA');
});

test('12 Nov (a Thursday release) uses the week ending 6 Nov: +4.657M, no float noise', () => {
  const e = ev('2026-11-12');
  applyOfficial([e], M(), T('2026-11-12', '17:00'));
  assert.equal(e.ac, '4.657M');
});

test('not released yet, or no observation for the week: nothing is filled', () => {
  const early = ev('2026-11-18'); applyOfficial([early], M(), T('2026-11-18', '15:00'));
  assert.equal(early.ac, null);
  const noWeek = ev('2026-11-25'); applyOfficial([noWeek], M(), T('2026-11-25', '17:00'));   // 20 Nov not published yet
  assert.equal(noWeek.ac, null);
});

test('a hand-typed placeholder is replaced inside 3 days, and a FinancialJuice number is confirmed (tag EIA) or corrected', () => {
  const typed = ev('2026-11-18', { ac: '9.999M', sr: { ac: 'ref' } });
  applyOfficial([typed], M(), T('2026-11-19', '04:30'));
  assert.equal(typed.ac, '-1.557M'); assert.equal(typed.sr.ac, 'EIA');
  const agree = ev('2026-11-18', { ac: '-1.557M', sr: { ac: 'FJ' } });
  const o1 = applyOfficial([agree], M(), T('2026-11-18', '16:00'));
  assert.equal(agree.sr.ac, 'EIA'); assert.equal(o1.wire[0].agree, true); assert.equal(agree.flag, undefined);
  const wrong = ev('2026-11-18', { ac: '-1.500M', sr: { ac: 'FJ' } });
  applyOfficial([wrong], M(), T('2026-11-18', '16:00'));
  assert.equal(wrong.ac, '-1.557M'); assert.equal(wrong.wfix, '-1.500M'); assert.match(wrong.flag, /EIA says -1\.557M/);
});

test('the ledger keeps an EIA actual and previous across a cold start (rank equal to FRED) and puts them back with their tag', () => {
  const NOW = T('2026-11-19', '04:30'), led = newLedger();
  const live = ev('2026-11-18', { id: 'eia|2026-11-18|main' }); applyOfficial([live], M(), NOW);
  assert.equal(recordLedger(led, [live], NOW), true);
  assert.equal(led.rows[live.id].sa, 'EIA'); assert.equal(led.rows[live.id].sp, 'EIA');
  const cold = ev('2026-11-18'); cold.id = 'eia|2026-11-18|main';   // after a cold start the live sources show nothing
  assert.ok(applyLedger([cold], led, NOW) >= 2);
  assert.equal(cold.ac, '-1.557M'); assert.equal(cold.sr.ac, 'EIA'); assert.equal(cold.pv, '4.657M'); assert.equal(cold.sr.pv, 'EIA');
});

test('FRED rows keep their old behaviour in the ledger (pv tag FRED when none is stored)', () => {
  const NOW = T('2026-11-19', '04:30'), led = newLedger();
  const e = { id: 'claims|2026-11-19|main', k: 'claims', r: 'main', t: T('2026-11-19', '13:30') - 864e5, ac: '200K', pv: '191K', pvc: 'r', sr: { ac: 'FRED', pv: 'FRED' } };
  recordLedger(led, [e], NOW);
  const cold = { id: e.id, k: 'claims', r: 'main', t: e.t, ac: null, pv: null };
  applyLedger([cold], led, NOW);
  assert.equal(cold.ac, '200K'); assert.equal(cold.sr.ac, 'FRED'); assert.equal(cold.sr.pv, 'FRED'); assert.equal(cold.pvc, 'r');
});

test('the EIA series is the only non-FRED series', () => {
  assert.deepEqual(SERIES.filter(s => !/^[A-Z0-9]+$/.test(s)), ['EIA:WCESTUS1']);
});

// ---- display: three decimals like the reference calendar, from both the official number and the wire ----
import { applyWire, newMemo } from '../src/wire.js';

test('EIA numbers keep three decimals: 3.380M (not 3.38M), -1.500M, 0.000M; other M rows are untouched', () => {
  for (const [diff, want] of [[3380, '3.380M'], [-1500, '-1.500M'], [0, '0.000M'], [4657, '4.657M']]) {
    const e = ev('2026-11-18');
    applyOfficial([e], { 'EIA:WCESTUS1': parseEiaJson(api([['2026-11-06', 400000], ['2026-11-13', 400000 + diff]])) }, T('2026-11-19', '04:30'));
    assert.equal(e.ac, want);
  }
});

test('wire: the EIA post fills actual, forecast and previous with three decimals and the M suffix', () => {
  const e = ev('2026-11-18', { id: 'eia|2026-11-18|main', u: 'M' });   // real events carry the row's unit
  const posts = [{ id: 1, t: e.t + 20e3, text: 'EIA CRUDE OIL INVENTORIES ACTUAL 3.38M (FORECAST 0.4M, PREVIOUS 4.657M) $MACRO' }];
  applyWire([e], posts, e.t + 60e3, newMemo());
  assert.equal(e.ac, '3.380M'); assert.equal(e.fc, '0.400M'); assert.equal(e.pv, '4.657M');
  assert.deepEqual([e.sr.ac, e.sr.fc, e.sr.pv], ['FJ', 'FJ', 'FJ']);
});
