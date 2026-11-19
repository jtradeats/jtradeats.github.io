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

test('every series the Worker asks for has a SPEC row (17 FRED requests and 1 EIA request for a full poll)', () => {
  assert.equal(SERIES.length, 18);
  assert.equal(SERIES.filter(s => s.startsWith('EIA:')).length, 1);
});

// ---- every high-impact row FRED can answer. Levels are FRED observations read on 16 Nov 2026 (the year-ago PCE level and the ADP levels are made up) ----
import { SPEC, obsFor, calc } from '../src/official.js';
const S = pairs => new Map(pairs);
const T = (d, h) => Date.parse(`${d}T${h}:00Z`);
const run = (k, r, d, pd, M, h = '13:30') => { const e = { k, r, d, pd, t: T(d, h), ac: null, pv: null, title: k }; applyOfficial([e], M, T(d, '23:00')); return e; };

test('PPI, core PCE and retail sales: month-on-month from the index levels', () => {
  assert.equal(run('ppi', 'mom', '2026-11-13', 'Oct', { PPIFIS: S([['2026-09-01', 159.699], ['2026-10-01', 160.254]]) }).ac, '0.3%');
  const pce = { PCEPILFE: S([['2025-09-01', 127.0], ['2026-08-01', 130.489], ['2026-09-01', 130.902]]) };
  assert.equal(run('pce', 'mom', '2026-10-30', 'Sep', pce).ac, '0.3%');
  assert.equal(run('pce', 'yoy', '2026-10-30', 'Sep', pce).ac, '3.1%');
  assert.equal(run('retail', 'main', '2026-10-15', 'Sep', { RSAFS: S([['2026-08-01', 599797], ['2026-09-01', 605188]]) }).ac, '0.9%');
});

test('GDP: the quarter in the line ("Q3") picks the first day of that quarter; Q4 is reported in the next year', () => {
  const sp = SPEC['gdp|main'];
  assert.equal(obsFor({ d: '2026-10-29', pd: 'Q3' }, sp), '2026-07-01');
  assert.equal(obsFor({ d: '2027-01-28', pd: 'Q4' }, sp), '2026-10-01');
  assert.equal(obsFor({ d: '2027-03-25', pd: 'Q4' }, sp), '2026-10-01');
  assert.equal(obsFor({ d: '2026-07-30', pd: 'Q2' }, sp), '2026-04-01');
  assert.equal(obsFor({ d: '2026-10-29', pd: 'Oct' }, sp), null);
  const e = run('gdp', 'main', '2026-10-29', 'Q3', { A191RL1Q225SBEA: S([['2026-04-01', 2.2], ['2026-07-01', 3.4]]) });
  assert.equal(e.ac, '3.4%'); assert.equal(e.pv, '2.2%');
});

test('levels are shown in the units the calendar uses: JOLTS in millions, new and existing home sales, Philly Fed', () => {
  assert.equal(run('jolts', 'main', '2026-11-03', 'Sep', { JTSJOL: S([['2026-09-01', 7523]]) }, '15:00').ac, '7.523M');
  assert.equal(run('nhs', 'main', '2026-10-27', 'Sep', { HSN1F: S([['2026-08-01', 680], ['2026-09-01', 676]]) }, '15:00').ac, '676K');
  assert.equal(run('ehs', 'main', '2026-11-12', 'Oct', { EXHOSLUSM495S: S([['2026-09-01', 3970000], ['2026-10-01', 3750000]]) }, '15:00').ac, '3.75M');
  assert.equal(run('philly', 'main', '2026-10-15', 'Oct', { GACDFSA066MSFRBPHI: S([['2026-09-01', 37.8], ['2026-10-01', 20.9]]) }).ac, '20.9');
});

test('ADP: the monthly change in thousands, whether FRED gives the level in persons or in thousands', () => {
  assert.equal(run('adp', 'main', '2026-11-04', 'Oct', { ADPMNUSNERSA: S([['2026-09-01', 135000000], ['2026-10-01', 135086000]]) }, '13:15').ac, '86K');
  assert.equal(run('adp', 'main', '2026-11-04', 'Oct', { ADPMNUSNERSA: S([['2026-09-01', 135000], ['2026-10-01', 135086]]) }, '13:15').ac, '86K');
});

test('a typed number that differs from FRED within 3 days of the print is flagged, and an older one is left alone', () => {
  const M = { RSAFS: S([['2026-08-01', 599797], ['2026-09-01', 605188]]) };
  const e = { k: 'retail', r: 'main', d: '2026-10-15', pd: 'Sep', t: T('2026-10-15', '12:30'), ac: '0.5%', pv: null, title: 'Retail' };
  const o = applyOfficial([e], M, T('2026-10-16', '12:00'));
  assert.match(e.flag, /FRED.*0\.9%.*0\.5%/); assert.equal(o.issues.length, 1);
  const old = { ...e, flag: undefined };
  assert.equal(applyOfficial([old], M, T('2026-10-25', '12:00')).issues.length, 0);
});

test('durable goods, PMIs, surveys, auctions and the Fed decision are deliberately not in SPEC', () => {
  for (const k of ['dgo|main', 'ism_m|pmi', 'spg_m|main', 'chi|main', 'cb|main', 'auc10|main', 'auc30|main', 'fomc|dec']) assert.ok(!SPEC[k], k);
});

test('every SPEC row names a kind and row that exist in indicators.json', async () => {
  const { readFileSync } = await import('node:fs');
  const IND = JSON.parse(readFileSync(new URL('../config/indicators.json', import.meta.url)));
  for (const key of Object.keys(SPEC)) {
    const [k, r] = key.split('|');
    assert.ok(IND.kinds[k] && IND.kinds[k].rows.some(x => x.id === r), key);
    assert.equal(IND.kinds[k].imp, 3, `${key} is a high-impact row`);
  }
  // and the unit of the row is the unit SPEC formats with
  for (const [key, sp] of Object.entries(SPEC)) { const [k, r] = key.split('|'); assert.equal(IND.kinds[k].rows.find(x => x.id === r).u || '', sp.u, key); }
});
