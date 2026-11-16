// node --test worker/test/wire.test.mjs
// The FinancialJuice posts below are the real wording sent on 16 Nov 2026 (cleaned the way feed.js cleans them: "|FJ" tail removed, a leading red mark removed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { etToMs } from '../src/schedule.js';
import { applyOfficial, parseFredJson } from '../src/official.js';
import { RULES, WIRE_KEYS, parseWire, inRowUnit, applyWire, newMemo, recordConfirms, wireSummary } from '../src/wire.js';

const IND = JSON.parse(readFileSync(new URL('../config/indicators.json', import.meta.url)));

const P = {
  nfp: '‼ BREAKING: US NONFARM PAYROLLS ACTUAL 165K (FORECAST 70K, PREVIOUS 29K) $MACRO',
  cpi: '‼ BREAKING: US CPI MOM ACTUAL 0.4% (FORECAST 0.3%, PREVIOUS 0.6%) $MACRO',
  core: 'US CORE CPI MOM ACTUAL 0.3% (FORECAST 0.2%, PREVIOUS 0.3%) $MACRO',               // the red mark is already removed by feed.js (hot: true)
  ppi: 'US PPI MOM ACTUAL 0.3% (FORECAST 0.4%, PREVIOUS 1.3%) $MACRO',
  ppiYoy: '‼ BREAKING: US PPI YOY ACTUAL 6.5% (FORECAST 6.6%, PREVIOUS 6.3%) $MACRO',
  corePpi: 'US CORE PPI MOM ACTUAL 0.3% (FORECAST 0.3%, PREVIOUS 0.7%) $MACRO',
  cut: '...(FORECAST 1.71M, PREVIOUS 1.718M) $MACRO',
  claims: 'US INITIAL JOBLESS CLAIMS ACTUAL 200K (FORECAST 194K, PREVIOUS 189K) $MACRO',
  jolts: 'US JOLTS JOB OPENINGS ACTUAL 7.523M (FORECAST 7.164M, PREVIOUS 7.079M) $MACRO',
  adp: 'US ADP EMPLOYMENT CHANGE ACTUAL 86K (FORECAST 67K, PREVIOUS 90K) $MACRO',
  retail: 'US RETAIL SALES MOM ACTUAL 0.8% (FORECAST 0.3%, PREVIOUS 1.2%) $MACRO',
  eia: 'EIA CRUDE OIL INVENTORIES ACTUAL 4.657M (FORECAST -1.483M, PREVIOUS -0.865M) $MACRO',
  a30: 'US 30 Yr Note Auction\n\nHigh Yield 5.441% [Tail 0.4 BPS]\nBid-to-cover 2.36\nSells $25 bln\nAwards 21.29% of bids at high\nPrimary Dealers take 11.39%\nDirect 20.5%\nIndirect 68.11%',
  a10: 'US 10 Yr Note Auction\n\nHigh Yield 5.020% [Tail 1 BPS]\nBid-to-cover 2.46\nSells $42 bln\nAwards 95.17% of bids at high\nPrimary Dealers take 9.8%\nDirect 29.0%\nIndirect 61.2%',
  rate: '‼ BREAKING: US INTEREST RATE DECISION ACTUAL 4% (FORECAST 4%, PREVIOUS 4%) $MACRO',
  stmt: 'Federal Reserve leaves key overnight interest rate unchanged in the 3.75-4.00% range, says accumulation of more information will help determine appropriate policy stance',
  vote: 'Fed: The vote in favor of the policy was 10-2, with Governor Cook and Hammack dissenting in favor of a 25-basis-point hike.',
};

const ev = (k, r, d, hm, title, u, extra = {}) => ({ id: `${k}|${d}|${r}`, t: etToMs(`${d}T${hm}`), k, r, d, title, u, dir: 'none', ac: null, fc: null, pv: null, hol: 0, src: 'schedule', ...extra });
const post = (text, t, id = 1) => ({ id, t, text, url: 'x', media: false });
const at = (e, s) => e.t + s * 1000;   // a post s seconds after the scheduled time

test('every real sample parses to the right release name, number and unit', () => {
  const g = (key, name, ac, fc, pv) => {
    const x = parseWire(P[key]);
    assert.ok(x, key); assert.equal(x.name, name, key);
    assert.deepEqual([x.ac && x.ac.n + x.ac.s, x.fc && x.fc.n + x.fc.s, x.pv && x.pv.n + x.pv.s], [ac, fc, pv], key);
    return x;
  };
  g('nfp', 'NONFARM PAYROLLS', '165K', '70K', '29K');
  g('cpi', 'CPI MOM', '0.4%', '0.3%', '0.6%');
  g('core', 'CORE CPI MOM', '0.3%', '0.2%', '0.3%');
  g('ppi', 'PPI MOM', '0.3%', '0.4%', '1.3%');
  g('claims', 'INITIAL JOBLESS CLAIMS', '200K', '194K', '189K');
  g('jolts', 'JOLTS JOB OPENINGS', '7.523M', '7.164M', '7.079M');
  g('adp', 'ADP EMPLOYMENT CHANGE', '86K', '67K', '90K');
  g('retail', 'RETAIL SALES MOM', '0.8%', '0.3%', '1.2%');
  g('eia', 'EIA CRUDE OIL INVENTORIES', '4.657M', '-1.483M', '-0.865M');
  g('rate', 'INTEREST RATE DECISION', '4%', '4%', '4%');
  for (const k of ['nfp', 'cpi', 'core', 'ppi', 'claims', 'jolts', 'adp', 'retail', 'eia', 'rate']) assert.ok(parseWire(P[k]).rule, k + ' has a rule');
  const a30 = parseWire(P.a30), a10 = parseWire(P.a10);
  assert.deepEqual([a30.rule.keys[0], a30.ac.n], ['auc30|main', 5.441]);
  assert.deepEqual([a10.rule.keys[0], a10.ac.n], ['auc10|main', 5.02]);
  assert.equal(a30.fc, null);
});

test('posts that are not a mapped release are left alone: other measures, cut-off posts, statement text, TIPS auctions', () => {
  assert.equal(parseWire(P.ppiYoy).rule, null);        // PPI YoY and core PPI have no row on the calendar
  assert.equal(parseWire(P.corePpi).rule, null);
  assert.equal(parseWire(P.cut), null);                // the pasted fragment has no ACTUAL
  assert.equal(parseWire(P.stmt), null);
  assert.equal(parseWire(P.vote), null);
  assert.equal(parseWire('US 10 Yr TIPS Auction\n\nHigh Yield 2.100% [Tail 1 BPS]'), null);
  assert.equal(parseWire('Oil rises as ACTUAL demand (FORECAST to rise) says analyst'), null);
});

test('a post fills the blank actual, forecast and previous of the row it follows, tagged FJ, in the row\'s unit', () => {
  const rows = [
    ev('nfp', 'nfp', '2026-11-06', '08:30', 'Nonfarm Payrolls (Oct)', 'K'),
    ev('cpi', 'mom', '2026-11-10', '08:30', 'CPI (MoM) (Oct)', '%'),
    ev('cpi', 'core', '2026-11-10', '08:30', 'Core CPI (MoM) (Oct)', '%'),
    ev('claims', 'main', '2026-11-12', '08:30', 'Initial Jobless Claims', 'K'),
    ev('jolts', 'main', '2026-11-03', '10:00', 'JOLTS Job Openings (Sep)', 'M'),
    ev('eia', 'main', '2026-11-12', '12:00', 'Crude Oil Inventories', 'M'),
    ev('fomc', 'dec', '2026-12-09', '14:00', 'Fed Interest Rate Decision', '%'),
    ev('auc10', 'main', '2026-11-10', '13:00', '10-Year Note Auction', '%'),
    ev('auc30', 'main', '2026-11-12', '13:00', '30-Year Bond Auction', '%'),
  ];
  const by = id => rows.find(e => e.id === id), memo = newMemo();
  const posts = [
    post(P.nfp, at(by('nfp|2026-11-06|nfp'), 4), 1), post(P.cpi, at(by('cpi|2026-11-10|mom'), 3), 2), post(P.core, at(by('cpi|2026-11-10|core'), 5), 3),
    post(P.claims, at(by('claims|2026-11-12|main'), 2), 4), post(P.jolts, at(by('jolts|2026-11-03|main'), 6), 5), post(P.eia, at(by('eia|2026-11-12|main'), 40), 6),
    post(P.rate, at(by('fomc|2026-12-09|dec'), 1), 7), post(P.a10, at(by('auc10|2026-11-10|main'), 70), 8), post(P.a30, at(by('auc30|2026-11-12|main'), 65), 9),
  ];
  // each post is read when it is new, as live (posts older than 6 hours are not ingested)
  for (const p of posts) { const r = applyWire(rows, [p], p.t + 1000, memo); assert.equal(r.changed, true); }
  assert.equal(rows.filter(e => e.ac != null).length, 9);
  const g = (id, f) => by(id)[f];
  assert.deepEqual([g('nfp|2026-11-06|nfp', 'ac'), g('nfp|2026-11-06|nfp', 'fc'), g('nfp|2026-11-06|nfp', 'pv')], ['165K', '70K', '29K']);
  assert.equal(g('cpi|2026-11-10|mom', 'ac'), '0.4%');
  assert.equal(g('cpi|2026-11-10|core', 'ac'), '0.3%');
  assert.equal(g('claims|2026-11-12|main', 'ac'), '200K');
  assert.equal(g('jolts|2026-11-03|main', 'ac'), '7.523M');
  assert.equal(g('eia|2026-11-12|main', 'ac'), '4.657M');
  assert.equal(g('eia|2026-11-12|main', 'fc'), '-1.483M');
  assert.equal(g('eia|2026-11-12|main', 'pv'), '-0.865M');
  assert.equal(g('fomc|2026-12-09|dec', 'ac'), '4.00%');
  assert.equal(g('auc10|2026-11-10|main', 'ac'), '5.020%');   // three decimals, as typed in results.json
  assert.equal(g('auc30|2026-11-12|main', 'ac'), '5.441%');
  assert.equal(g('auc30|2026-11-12|main', 'fc'), null);       // an auction has no forecast
  for (const e of rows) assert.equal(e.sr.ac, 'FJ', e.id);
});

test('typed numbers and provider numbers are never overwritten; an actual that disagrees with a typed one is flagged', () => {
  const e = ev('nfp', 'nfp', '2026-11-06', '08:30', 'Nonfarm Payrolls (Oct)', 'K', { ac: '165K', fc: '65K', pv: '60K', sr: { ac: 'ref', fc: 'ref', pv: 'ref' } });
  const memo = newMemo(), now = at(e, 60);
  let r = applyWire([e], [post(P.nfp, at(e, 4))], now, memo);
  assert.deepEqual([e.ac, e.fc, e.pv, e.sr.ac, e.sr.fc, e.sr.pv], ['165K', '65K', '60K', 'ref', 'ref', 'ref']);
  assert.equal(r.n, 0); assert.equal(e.flag, undefined);
  const e2 = ev('nfp', 'nfp', '2026-11-06', '08:30', 'Nonfarm Payrolls (Oct)', 'K', { ac: '150K', sr: { ac: 'ref' } });
  r = applyWire([e2], [post(P.nfp, at(e2, 4))], now, newMemo());
  assert.equal(e2.ac, '150K'); assert.match(e2.flag, /FinancialJuice says 165K, the typed number says 150K/);
  assert.equal(r.issues[0].code, 'wire_diff');
  const e3 = ev('nfp', 'nfp', '2026-11-06', '08:30', 'Nonfarm Payrolls (Oct)', 'K', { fc: '65K', sr: { fc: 'Fair Economy' } });
  applyWire([e3], [post(P.nfp, at(e3, 4))], now, newMemo());
  assert.deepEqual([e3.ac, e3.fc, e3.sr.fc, e3.pv], ['165K', '65K', 'Fair Economy', '29K']);
});

test('a post is matched by release time, never by name alone: last month\'s retail post does not fill this month\'s row', () => {
  const e = ev('retail', 'main', '2026-11-17', '08:30', 'Retail Sales (MoM) (Oct)', '%');
  const old = post(P.retail, etToMs('2026-10-16T08:30') + 4000);        // the September print, a month earlier
  const early = post(P.retail, e.t - 120000);                           // two minutes before the scheduled time
  const late = post(P.retail, e.t + 46 * 60000);                        // outside the 45-minute window
  const now = e.t + 50 * 60000;
  const r = applyWire([e], [old, early, late], now, newMemo());
  assert.equal(e.ac, null); assert.equal(r.n, 0);
  const ok = post(P.retail, e.t + 4000), e2 = { ...e, ac: null, fc: null, pv: null };
  applyWire([e2], [ok], e.t + 60000, newMemo());
  assert.equal(e2.ac, '0.8%');
});

test('numbers outside the row\'s bounds or in the wrong unit are rejected and reported, not shown', () => {
  const e = ev('nfp', 'nfp', '2026-11-06', '08:30', 'Nonfarm Payrolls (Oct)', 'K'), now = at(e, 30);
  let r = applyWire([e], [post('US NONFARM PAYROLLS ACTUAL 16500K (FORECAST 70K, PREVIOUS 29K) $MACRO', at(e, 4))], now, newMemo());
  assert.equal(e.ac, null); assert.equal(r.issues[0].code, 'wire_rejected');
  const c = ev('claims', 'main', '2026-11-12', '08:30', 'Initial Jobless Claims', 'K');
  r = applyWire([c], [post('US INITIAL JOBLESS CLAIMS ACTUAL 200 (FORECAST 194K, PREVIOUS 189K) $MACRO', at(c, 4))], at(c, 30), newMemo());
  assert.equal(c.ac, null);                                              // no unit on a K row
  const u = ev('nfp', 'unemp', '2026-11-06', '08:30', 'Unemployment Rate (Oct)', '%');
  applyWire([u], [post('US UNEMPLOYMENT RATE ACTUAL 41% (FORECAST 4.2%, PREVIOUS 4.2%) $MACRO', at(u, 4))], at(u, 30), newMemo());
  assert.equal(u.ac, null);
});

test('two different actuals for one row: the first stays and the row is flagged', () => {
  const e = ev('cpi', 'mom', '2026-11-10', '08:30', 'CPI (MoM) (Oct)', '%'), memo = newMemo();
  const r = applyWire([e], [post(P.cpi, at(e, 3), 1), post(P.cpi.replace('ACTUAL 0.4%', 'ACTUAL 0.5%'), at(e, 20), 2)], at(e, 60), memo);
  assert.equal(e.ac, '0.4%'); assert.match(e.flag, /posted 0.4% and then 0.5%/);
  assert.ok(r.issues.some(i => i.code === 'wire_conflict'));
  const again = applyWire([{ ...e, ac: null, flag: undefined, sr: undefined }], [post(P.cpi, at(e, 3), 1)], at(e, 90), memo);   // same post read again: no new conflict, same answer
  assert.equal(again.n, 1);
});

test('the memo keeps the number after the post has left the window, and drops it after 3 days', () => {
  const e = ev('claims', 'main', '2026-11-12', '08:30', 'Initial Jobless Claims', 'K'), memo = newMemo();
  applyWire([e], [post(P.claims, at(e, 2))], at(e, 30), memo);
  const later = ev('claims', 'main', '2026-11-12', '08:30', 'Initial Jobless Claims', 'K');
  applyWire([later], [], at(e, 7200), memo);
  assert.equal(later.ac, '200K'); assert.equal(later.sr.ac, 'FJ');
  const gone = ev('claims', 'main', '2026-11-12', '08:30', 'Initial Jobless Claims', 'K');
  applyWire([gone], [], at(e, 4 * 864e5), memo);
  assert.equal(gone.ac, null);
});

// ---- the official side: FRED confirms or corrects the wire's number ----
const icsa = v => ({ ICSA: parseFredJson(JSON.stringify({ observations: [{ date: '2026-10-31', value: '189000' }, { date: '2026-11-07', value: String(v) }] })) });
const claimsRow = () => ev('claims', 'main', '2026-11-12', '08:30', 'Initial Jobless Claims', 'K');

test('FRED agrees with the wire: the tag becomes FRED and nothing is flagged', () => {
  const e = claimsRow(), memo = newMemo(), now = at(e, 300);
  applyWire([e], [post(P.claims, at(e, 2))], now, memo);
  assert.equal(e.sr.ac, 'FJ');
  const o = applyOfficial([e], icsa(200000), now);
  assert.equal(e.ac, '200K'); assert.equal(e.sr.ac, 'FRED'); assert.equal(e.flag, undefined); assert.equal(e.wfix, undefined);
  assert.equal(o.issues.length, 0); assert.deepEqual(o.wire.map(x => [x.id, x.fj, x.off, x.agree]), [[e.id, '200K', '200K', true]]);
});

test('FRED differs from the wire: the official number is shown, the wire\'s is kept in wfix and the row is flagged', () => {
  const e = claimsRow(), memo = newMemo(), now = at(e, 300);
  applyWire([e], [post(P.claims, at(e, 2))], now, memo);
  const o = applyOfficial([e], icsa(201000), now);
  assert.equal(e.ac, '201K'); assert.equal(e.wfix, '200K'); assert.equal(e.sr.ac, 'FRED');
  assert.match(e.flag, /FinancialJuice said 200K, FRED \(official series\) says 201K/);
  assert.equal(o.issues[0].code, 'wire_corrected'); assert.equal(o.wire[0].agree, false);
});

test('a row FRED does not cover keeps the FJ tag (nothing confirms it)', () => {
  const e = ev('eia', 'main', '2026-11-12', '12:00', 'Crude Oil Inventories', 'M'), now = at(e, 300);
  applyWire([e], [post(P.eia, at(e, 40))], now, newMemo());
  applyOfficial([e], { ICSA: new Map() }, now);
  assert.equal(e.ac, '4.657M'); assert.equal(e.sr.ac, 'FJ');
});

test('the wire\'s previous (before revisions) is replaced by the official previous', () => {
  const prev = claimsRow(); prev.d = '2026-11-05'; prev.id = 'claims|2026-11-05|main'; prev.t = etToMs('2026-11-05T08:30'); prev.ac = '189K'; prev.sr = { ac: 'ref' };
  const e = claimsRow(), now = at(e, 300);
  applyWire([prev, e], [post(P.claims.replace('PREVIOUS 189K', 'PREVIOUS 195K'), at(e, 2))], now, newMemo());
  assert.equal(e.pv, '195K'); assert.equal(e.sr.pv, 'FJ');
  applyOfficial([prev, e], icsa(200000), now);
  assert.equal(e.sr.pv, 'FRED'); assert.equal(e.pv, '189K');
});

test('confirmations are logged once per row, with the wire\'s lag, and summarised', () => {
  const e = claimsRow(), memo = newMemo(), now = at(e, 300);
  applyWire([e], [post(P.claims, at(e, 2))], now, memo);
  const o = applyOfficial([e], icsa(200000), now);
  assert.equal(recordConfirms(memo, o.wire, now), true);
  assert.equal(recordConfirms(memo, o.wire, now + 1000), false);
  const s = wireSummary(memo);
  assert.deepEqual([s.compared, s.agree, s.disagree, s.postLagMedianS], [1, 1, 0, 2]);
});

test('every row the wire fills exists in indicators.json, and the wire\'s unit class fits the row', () => {
  for (const k of WIRE_KEYS) {
    const [kind, row] = k.split('|'), kd = IND.kinds[kind];
    assert.ok(kd, 'kind ' + kind); assert.ok(kd.rows.some(r => r.id === row), 'row ' + k);
  }
  assert.equal(inRowUnit({ n: 7.523, s: 'M' }, 'M'), 7.523);
  assert.equal(inRowUnit({ n: 0.676, s: 'M' }, 'K'), 676);
  assert.equal(inRowUnit({ n: 55.5, s: '' }, ''), 55.5);
  assert.equal(inRowUnit({ n: 55.5, s: '%' }, ''), null);
  assert.ok(RULES.every(r => r.lo < r.hi));
});
