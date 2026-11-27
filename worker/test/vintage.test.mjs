// P8.18: a later GDP estimate is never read from FRED until FRED has the new value; the awaiting state; the lag log. Run: node --test test/vintage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOfficial, markPending, parseFredVintage, fredVintageUrl, REVISION } from '../src/official.js';

const T = (d, h) => Date.parse(`${d}T${h}:00Z`) + 5 * 3600e3;   // ET (EST) to UTC
const S = a => new Map(a);
const gdp = (o = {}) => ({ id: 'gdp|2026-11-25|main', k: 'gdp', r: 'main', d: '2026-11-25', pd: 'Q3', n: 'Second estimate', t: T('2026-11-25', '08:30'), ac: null, pv: '3.4%', title: 'GDP', ...o });
const NOW = T('2026-11-25', '08:35');
const series = cur => ({ A191RL1Q225SBEA: S([['2026-04-01', 3.8], ['2026-07-01', cur]]) });
const vint = rows => (ser, ob) => (ser === 'A191RL1Q225SBEA' ? rows[ob] : undefined);

test('REVISION matches the second and third estimates only', () => {
  assert.ok(REVISION.test('Second estimate')); assert.ok(REVISION.test('Third estimate'));
  assert.ok(!REVISION.test('Advance estimate')); assert.ok(!REVISION.test('')); assert.ok(!REVISION.test("Date follows the Fed's rule"));
});

test('25 Nov, no vintage data: FRED still on the advance value (3.4) gives no actual, and the previous is the prior quarter', () => {
  const e = gdp(), o = applyOfficial([e], series(3.4), NOW);
  assert.equal(e.ac, null); assert.equal(e.sr.ac, undefined, 'no source is credited with an actual');
  // since 26 Nov a later estimate's previous is the PRIOR QUARTER's growth, as for every other row (Bloomberg, Investing and Finviz all show Q2 against the Q3 second estimate), not the earlier estimate of the same quarter
  assert.equal(e.pv, '3.8%'); assert.equal(e.sr.pv, 'FRED');
  assert.equal(o.n, 0); assert.equal(o.skipped.length, 1); assert.match(o.skipped[0].why, /earlier estimate/);
});

test('25 Nov, no vintage data: FRED on 3.2 (revised) fills the actual, tags it FRED, and the previous is the prior quarter', () => {
  const e = gdp(), o = applyOfficial([e], series(3.2), NOW);
  assert.equal(e.ac, '3.2%'); assert.equal(e.sr.ac, 'FRED'); assert.equal(e.pv, '3.8%'); assert.equal(o.n, 1); assert.equal(o.skipped.length, 0);
});

test('no vintage data and nothing to compare with: held, not guessed', () => {
  const e = gdp({ pv: null }), o = applyOfficial([e], series(3.2), NOW);
  assert.equal(e.ac, null); assert.match(o.skipped[0].why, /no earlier estimate/);
});

test('with vintage data: a value that began before the release day is held, one that began on it is taken', () => {
  const held = gdp(), a = applyOfficial([held], series(3.4), NOW, { vint: vint({ '2026-07-01': { v: 3.4, rs: '2026-10-29' } }) });
  assert.equal(held.ac, null); assert.match(a.skipped[0].why, /held since 2026-10-29/);
  const got = gdp(), b = applyOfficial([got], series(3.2), NOW, { vint: vint({ '2026-07-01': { v: 3.2, rs: '2026-11-25' } }) });
  assert.equal(got.ac, '3.2%'); assert.equal(b.skipped.length, 0);
});

test('vintage data decides even when the numbers alone could not: a revision back to the same value is taken only if FRED says it began on the day', () => {
  const e = gdp(), o = applyOfficial([e], series(3.4), NOW, { vint: vint({ '2026-07-01': { v: 3.4, rs: '2026-11-25' } }) });
  assert.equal(e.ac, '3.4%'); assert.equal(o.n, 1);
});

test('the series and its vintage must agree', () => {
  const e = gdp(), o = applyOfficial([e], series(3.4), NOW, { vint: vint({ '2026-07-01': { v: 3.2, rs: '2026-11-25' } }) });
  assert.equal(e.ac, null); assert.match(o.skipped[0].why, /disagree/);
});

test('the third estimate follows the same rule', () => {
  const e = gdp({ id: 'gdp|2026-12-23|main', d: '2026-12-23', n: 'Third estimate', t: T('2026-12-23', '08:30'), pv: '3.2%' });
  const o = applyOfficial([e], series(3.2), T('2026-12-23', '08:40'));
  assert.equal(e.ac, null); assert.equal(o.skipped.length, 1);
  applyOfficial([e], series(3.1), T('2026-12-23', '08:41')); assert.equal(e.ac, '3.1%');
});

test('the advance estimate is not held, and still gets its previous from the series', () => {
  const e = gdp({ id: 'gdp|2026-10-29|main', d: '2026-10-29', n: 'Advance estimate', t: T('2026-10-29', '08:30'), pv: null });
  applyOfficial([e], { A191RL1Q225SBEA: S([['2026-04-01', 2.2], ['2026-07-01', 3.4]]) }, T('2026-10-29', '08:35'));
  assert.equal(e.ac, '3.4%'); assert.equal(e.pv, '2.2%');
});

test('a wire number for the later estimate is not overwritten by the stale FRED value', () => {
  const e = gdp({ ac: '3.2%', sr: { ac: 'FJ' } }), o = applyOfficial([e], series(3.4), NOW);
  assert.equal(e.ac, '3.2%'); assert.equal(e.sr.ac, 'FJ'); assert.equal(e.flag, undefined); assert.equal(o.wire.length, 0);
});

test('a typed number for the later estimate is not flagged against the stale FRED value', () => {
  const e = gdp({ ac: '3.2%', sr: { ac: 'ref' } }), o = applyOfficial([e], series(3.4), NOW);
  assert.equal(e.ac, '3.2%'); assert.equal(e.flag, undefined); assert.equal(o.issues.length, 0);
});

test('a missing year-on-year base is reported, not silent', () => {
  const e = { id: 'cpi|2026-11-13|yoy', k: 'cpi', r: 'yoy', d: '2026-11-13', pd: 'Oct', t: T('2026-11-13', '08:30'), ac: null, pv: null, title: 'CPI' };
  const o = applyOfficial([e], { CPIAUCNS: S([['2026-10-01', 330], ['2026-09-01', 329]]) }, T('2026-11-13', '09:00'));
  assert.equal(e.ac, null); assert.deepEqual(o.skipped, [{ id: e.id, why: 'no base for 2025-10-01' }]);
});

test('parseFredVintage keeps the newest value of each observation and the day it began', () => {
  const j = rows => JSON.stringify({ observations: rows.map(([date, value, rs]) => ({ date, value, realtime_start: rs, realtime_end: '9999-12-31' })) });
  const m = parseFredVintage(j([['2026-07-01', '3.4', '2026-10-29'], ['2026-07-01', '3.2', '2026-11-25'], ['2026-04-01', '3.8', '2026-10-09'], ['2026-10-01', '.', '2026-11-25']]));
  assert.deepEqual([...m], [['2026-07-01', { v: 3.2, rs: '2026-11-25' }], ['2026-04-01', { v: 3.8, rs: '2026-10-09' }]]);
  assert.equal(parseFredVintage(j([['2026-07-01', '3.2', '2026-11-25'], ['2026-07-01', '3.4', '2026-10-29']])).get('2026-07-01').v, 3.2, 'order in the answer does not matter');
  assert.throws(() => parseFredVintage('<html>'), /not JSON/); assert.throws(() => parseFredVintage('{"error_message":"Bad key"}'), /Bad key/);
});

test('the vintage request asks for every value since the day given, with the key encoded', () => {
  const u = new URL(fredVintageUrl('A191RL1Q225SBEA', 'a&b', '2026-05-01', '2026-10-09'));
  assert.equal(u.searchParams.get('realtime_start'), '2026-10-09'); assert.equal(u.searchParams.get('realtime_end'), '9999-12-31');
  assert.equal(u.searchParams.get('api_key'), 'a&b'); assert.equal(u.searchParams.get('observation_start'), '2026-05-01');
});

test('markPending: covered rows released within 6 h with no actual; nothing else', () => {
  const rows = [
    gdp({ id: 'a' }),                                                                                           // covered, out 5 min, blank
    gdp({ id: 'b', ac: '3.2%' }),                                                                               // has an actual
    gdp({ id: 'c', t: NOW + 60000 }),                                                                           // not out yet
    gdp({ id: 'd', t: NOW - 7 * 36e5 }),                                                                        // out more than 6 h
    { id: 'e', k: 'ism', r: 'main', d: '2026-11-25', t: NOW - 60000, ac: null },                                // not covered by FRED
    gdp({ id: 'f', hol: true }), gdp({ id: 'g', src: 'feed' }),
  ];
  const out = markPending(rows, NOW);
  assert.deepEqual(out, [{ id: 'a', min: 5 }]);
  assert.deepEqual(rows.filter(r => r.aw).map(r => r.id), ['a']);
});
