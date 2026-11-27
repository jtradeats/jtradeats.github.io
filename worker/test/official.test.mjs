// node --test worker/test/official.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand, etToMs, chainPrevious, applyResults } from '../src/schedule.js';
import { parseFredCsv, applyOfficial, obsFor, SPEC, SERIES } from '../src/official.js';

const J = f => JSON.parse(readFileSync(new URL('../config/' + f, import.meta.url)));
const SCHED = J('schedule.json'), IND = J('indicators.json'), RES = J('results.json');
const csv = (id, rows) => `observation_date,${id}\n` + rows.map(r => r.join(',')).join('\n');
const fresh = () => expand(SCHED, IND).map(e => ({ ...e }));
const get = (ev, id) => ev.find(e => e.id === id);
const AFTER = etToMs('2026-11-14T12:00');

test('parser skips missing values and reads either header style', () => {
  const m = parseFredCsv('DATE,ICSA\n2026-11-07,200000\n2026-11-14,.\n2026-11-21,');
  assert.equal(m.size, 1); assert.equal(m.get('2026-11-07'), 200000);
});

test('claims map to the Saturday before the release, Wednesday holiday weeks included', () => {
  const ev = fresh();
  assert.equal(obsFor(get(ev, 'claims|2026-11-12|main'), SPEC['claims|main']), '2026-11-07');
  assert.equal(obsFor(get(ev, 'claims|2026-11-25|main'), SPEC['claims|main']), '2026-11-21');
});

test('monthly rows use the reference month named in the schedule line, across the year end', () => {
  const ev = fresh();
  assert.equal(obsFor(get(ev, 'nfp|2026-11-06|nfp'), SPEC['nfp|nfp']), '2026-10-01');
  assert.equal(obsFor(get(ev, 'cpi|2027-01-13|mom'), SPEC['cpi|mom']), '2026-12-01');
});

test('official numbers fill blanks: claims, payrolls, unemployment, earnings, CPI m/m and y/y', () => {
  const ev = fresh();
  const M = {
    ICSA: parseFredCsv(csv('ICSA', [['2026-10-31', 191000], ['2026-11-07', 200000]])),
    PAYEMS: parseFredCsv(csv('PAYEMS', [['2026-08-01', 100000], ['2026-09-01', 100060], ['2026-10-01', 100225]])),
    UNRATE: parseFredCsv(csv('UNRATE', [['2026-09-01', 4.2], ['2026-10-01', 4.1]])),
    CES0500000003: parseFredCsv(csv('A', [['2026-09-01', 37.00], ['2026-10-01', 37.15]])),
    CPIAUCSL: parseFredCsv(csv('C', [['2026-09-01', 300.0], ['2026-10-01', 301.2]])),
    CPILFESL: parseFredCsv(csv('K', [['2026-09-01', 310.0], ['2026-10-01', 310.9]])),
    CPIAUCNS: parseFredCsv(csv('N', [['2025-10-01', 290.0], ['2026-10-01', 301.0]])),
  };
  const r = applyOfficial(ev, M, AFTER);
  assert.equal(get(ev, 'claims|2026-11-12|main').ac, '200K');
  assert.equal(get(ev, 'nfp|2026-11-06|nfp').ac, '165K');
  assert.equal(get(ev, 'nfp|2026-11-06|nfp').pv, '60K');
  assert.equal(get(ev, 'nfp|2026-11-06|unemp').ac, '4.1%');
  assert.equal(get(ev, 'nfp|2026-11-06|ahe').ac, '0.4%');
  assert.equal(get(ev, 'cpi|2026-11-10|mom').ac, '0.4%');
  assert.equal(get(ev, 'cpi|2026-11-10|core').ac, '0.3%');
  assert.equal(get(ev, 'cpi|2026-11-10|yoy').ac, '3.8%');
  assert.equal(get(ev, 'cpi|2026-11-10|mom').sr.ac, 'FRED');
  assert.equal(get(ev, 'claims|2026-11-19|main').ac, null);   // not released yet
  assert.ok(r.n >= 7 && r.issues.length === 0);
  assert.equal(SERIES.length, 18);   // P8.17: every series the SPEC reads: 17 FRED series and, since P8.38a, the one EIA series (EIA:WCESTUS1)
});

test('a typed number is a placeholder: the official series replaces it, with no flag; a provider number that disagrees is still flagged', () => {
  const ev = fresh(); applyResults(ev, RES);
  const M = { ICSA: parseFredCsv(csv('ICSA', [['2026-10-31', 191000], ['2026-11-07', 201000]])) };
  const day = etToMs('2026-11-13T09:00');   // one day after the 12 Nov print
  const r = applyOfficial(ev, M, day);
  const c = get(ev, 'claims|2026-11-12|main');
  assert.equal(c.ac, '201K'); assert.equal(c.sr.ac, 'FRED');   // typed 200K was only a placeholder
  assert.equal(c.flag, undefined); assert.equal(r.issues.length, 0);
  const ev2 = fresh(); const p = get(ev2, 'claims|2026-11-12|main'); p.ac = '200K'; p.sr = { ac: 'Fair Economy' };   // a real provider number
  const r2 = applyOfficial(ev2, M, day);
  assert.equal(p.ac, '200K'); assert.match(p.flag, /201K/); assert.equal(r2.issues[0].code, 'official_diff');
  const ev3 = fresh(); applyResults(ev3, RES);
  applyOfficial(ev3, M, etToMs('2026-11-30T09:00'));   // old rows: later vintages are not compared, so the typed number stays
  assert.equal(get(ev3, 'claims|2026-11-12|main').ac, '200K'); assert.equal(get(ev3, 'claims|2026-11-12|main').sr.ac, 'ref');
});

test('revised previous: official value differs from the earlier first print, so it is shown underlined (red for claims)', () => {
  const ev = fresh();
  get(ev, 'claims|2026-11-05|main').ac = '189K';   // what the 5 Nov release first showed
  const M = { ICSA: parseFredCsv(csv('ICSA', [['2026-10-31', 191000], ['2026-11-07', 200000]])) };
  applyOfficial(ev, M, AFTER);
  const c = get(ev, 'claims|2026-11-12|main');
  assert.equal(c.pv, '191K'); assert.equal(c.pvc, 'r'); assert.equal(c.sr.pv, 'FRED');
});

test('a typed previous is a placeholder: the official one replaces it, and the typed revision mark is worked out again', () => {
  const ev = fresh(); applyResults(ev, RES);
  const M = { ICSA: parseFredCsv(csv('ICSA', [['2026-10-31', 195000], ['2026-11-07', 200000]])) };
  applyOfficial(ev, M, AFTER);
  const c = get(ev, 'claims|2026-11-12|main');
  assert.equal(c.pv, '195K'); assert.equal(c.sr.pv, 'FRED');
  assert.equal(c.pvc, 'r');   // 5 Nov printed 189K, the official series now says 195K: revised up, red for claims
});

test('chained previous still works after official fills', () => {
  const ev = fresh();
  const M = { ICSA: parseFredCsv(csv('ICSA', [['2026-10-31', 191000], ['2026-11-07', 200000]])) };
  applyOfficial(ev, M, AFTER); chainPrevious(ev);
  assert.equal(get(ev, 'claims|2026-11-12|main').pv, '191K');
});
