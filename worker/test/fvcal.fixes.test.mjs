// P8.44 and the 26 Nov repairs: Finviz parse and second opinion, the 25 Nov wire wordings, title patterns, tags and labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFvCal, normFv, applyFvActuals, fvOverlayRows } from '../src/fvcal.js';
import { applyWire, newMemo, unmatchedUsNames } from '../src/wire.js';
import { applyOfficial, markPending } from '../src/official.js';
import { candidates, overlay, etToMs } from '../src/schedule.js';
import { recordLedger, applyLedger, newLedger, rankOf } from '../src/ledger.js';

const IND = JSON.parse(readFileSync(new URL('../config/indicators.json', import.meta.url)));
const T = etToMs('2026-11-25T08:30'), NOW = T + 3600e3;
const ev = (k, r, u, extra = {}) => ({ id: `${k}|2026-11-25|${r}`, t: T, d: '2026-11-25', k, r, u, title: k, src: 'schedule', dir: 'grow', n: null, fc: null, pv: null, ac: null, ...extra });
// synthetic page in the markup fvcal.js documents (the real page is checked after deploy through /calendar?debug=1)
const page = rows => '<table><tr><th>Wed Nov 25</th></tr>' + rows.map(([title, ac, fc, pv], i) =>
  `<tr id="event-${1000 + i}"><td>8:30 AM</td><td><a>${title}</a></td><td><svg></svg></td><td>Oct</td><td>${ac}</td><td>${fc}</td><td>${pv}</td><td></td></tr>`).join('') + '</table>';
const ROWS = [['Durable Goods Orders MoM', '0.2%', '0.6%', '2.0%'], ['Durable Goods Orders Ex Transp MoM', '0.5%', '0.5%', '0.5%'], ['GDP Price Index QoQ 2nd Est', '1.8%', '2.3%', '6.1%'],
  ['New Home Sales', '701K', '0.65M', '676K'], ['New Home Sales MoM', '14.2%', '-', '-0.6%'], ['EIA Crude Oil Stocks Change', '1.11M', '1.5M', '3.38M'], ['EIA Cushing Crude Oil Stocks Change', '-0.534M', '-', '-1.209M'],
  ['Jobless Claims 4-week Average', '196.00K', '-', '197.50K'], ['Core PCE Price Index YoY', '3.3%', '3.2%', '3.1%']];
const fv = () => normFv(parseFvCal(page(ROWS), '2026-11-23'), IND);

test('only dashboard rows come out of the Finviz page, in the row unit', () => {
  const r = fv();
  assert.deepEqual(r.map(x => x.title).sort(), ['Core PCE Price Index YoY', 'Durable Goods Orders MoM', 'EIA Crude Oil Stocks Change', 'New Home Sales']);
  const by = t => r.find(x => x.title === t);
  assert.equal(by('New Home Sales').fc, '650K');
  assert.equal(by('EIA Crude Oil Stocks Change').pv, '3.380M');
  assert.equal(by('EIA Crude Oil Stocks Change').ac, '1.11M');   // never padded to 1.110M
  assert.ok(fvOverlayRows(r).every(x => x.ac === null));
});

test('FinancialJuice durable goods post of 25 Nov fills the row; the core post does not', () => {
  const posts = [
    { id: 1, t: T + 20e3, text: 'US DURABLE GOODS ACTUAL 0.2% (FORECAST 0.7%, PREVIOUS 1.9%) $MACRO' },
    { id: 2, t: T + 21e3, text: 'US CORE DURABLE GOODS ACTUAL 0.5% (FORECAST 0.5%, PREVIOUS 0.5%) $MACRO' }];
  const e = ev('dgo', 'main', '%');
  applyWire([e], posts, NOW, newMemo());
  assert.equal(e.ac, '0.2%');
  assert.equal(e.sr.ac, 'FJ');
  assert.deepEqual(unmatchedUsNames(posts).map(x => x.name), ['CORE DURABLE GOODS']);
});

test('new home sales wording with UNITS converts to K', () => {
  const e = ev('nhs', 'main', 'K');
  applyWire([e], [{ id: 3, t: T + 30e3, text: 'US NEW HOME SALES - UNITS ACTUAL 0.701M (FORECAST 0.65M, PREVIOUS 0.676M) $MACRO' }], NOW, newMemo());
  assert.equal(e.ac, '701K');
});

test('second opinion: agrees (also through rounding), disagrees, and fills a blank', () => {
  const dgo = ev('dgo', 'main', '%', { ac: '0.2%', sr: { ac: 'FJ' } });
  const eia = ev('eia', 'main', 'M', { ac: '1.109M', sr: { ac: 'FJ' } });
  const pce = ev('pce', 'yoy', '%', { ac: '3.1%', sr: { ac: 'FJ' } });
  const nhs = ev('nhs', 'main', 'K');
  const rows = fv().map(r => ({ ...r, t: T }));
  const out = applyFvActuals([dgo, eia, pce, nhs], rows, IND, NOW);
  assert.equal(dgo.cf, 'Finviz');
  assert.equal(eia.cf, 'Finviz'); assert.equal(eia.flag, undefined);
  assert.match(pce.flag, /Finviz says 3\.3%/); assert.equal(pce.ac, '3.1%');
  assert.equal(nhs.ac, '701K'); assert.equal(nhs.sr.ac, 'Finviz');
  assert.deepEqual([out.n, out.confirmed, out.issues.length], [1, 2, 1]);
});

test('a real crude disagreement beyond the rounding is still flagged', () => {
  const eia = ev('eia', 'main', 'M', { ac: '1.120M', sr: { ac: 'FJ' } });
  applyFvActuals([eia], fv().map(r => ({ ...r, t: T })), IND, NOW);
  assert.ok(eia.flag);
});

test('official figure settles a Finviz figure and clears the unofficial disagreement', () => {
  const S = new Map([['2026-09-01', 100], ['2025-10-01', 100], ['2025-09-01', 99], ['2026-10-01', 103.3]]);
  const a = ev('pce', 'yoy', '%', { pd: 'Oct', ac: '3.1%', sr: { ac: 'Finviz' } });
  const r = applyOfficial([a], { PCEPILFE: S }, NOW);
  assert.equal(a.ac, '3.3%'); assert.equal(a.sr.ac, 'FRED'); assert.equal(a.wfix, '3.1%'); assert.equal(a.wsrc, 'Finviz');
  assert.equal(r.wire.length, 0);   // not a wire comparison
  const b = ev('pce', 'yoy', '%', { pd: 'Oct', ac: '3.3%', sr: { ac: 'FJ' }, flag: 'FinancialJuice said 3.3%, Finviz says 3.2%; showing 3.3%' });
  applyOfficial([b], { PCEPILFE: S }, NOW);
  assert.equal(b.flag, undefined); assert.equal(b.sr.ac, 'FRED');
});

test('awaiting label waits 10 minutes on wire-covered rows only', () => {
  const mk = () => [ev('claims', 'main', 'K')];
  assert.equal(markPending(mk(), T + 60e3, () => true).length, 0);
  assert.equal(markPending(mk(), T + 11 * 60e3, () => true).length, 1);
  assert.equal(markPending(mk(), T + 60e3, () => false).length, 1);
});

test('title patterns: look-alike names never land on a dashboard row', () => {
  for (const t of ['Prelim GDP Price Index q/q', 'GDP Price Index QoQ 2nd Est', 'New Home Sales MoM', 'Jobless Claims 4-week Average', 'Continuing Jobless Claims', 'EIA Cushing Crude Oil Stocks Change']) assert.deepEqual(candidates(IND, t), [], t);
  for (const t of ['Prelim GDP q/q', 'GDP Growth Rate QoQ 2nd Est', 'New Home Sales', 'Initial Jobless Claims', 'Unemployment Claims', 'EIA Crude Oil Stocks Change', 'Crude Oil Inventories', 'Existing Home Sales', 'Nonfarm Payrolls']) assert.ok(candidates(IND, t).length, t);
});

test('Finviz is laid under Forex Factory and raises no time warning; ledger ranks it between wire and Forex Factory', () => {
  const o = overlay([ev('dgo', 'main', '%')], [{ name: 'Finviz', rows: fvOverlayRows(fv()).map(r => ({ ...r, t: T + 3.5 * 3600e3 })), noTime: true },
    { name: 'Fair Economy', rows: [{ t: T, title: 'Durable Goods Orders m/m', imp: 2, fc: '0.7%', pv: null, ac: null }] }], IND, NOW);
  assert.equal(o.events[0].fc, '0.7%'); assert.equal(o.events[0].pv, '2.0%'); assert.equal(o.issues.length, 0);
  assert.ok(rankOf('Finviz') > rankOf('FJ') && rankOf('Finviz') < rankOf('Fair Economy'));
  const mem = newLedger();
  recordLedger(mem, [ev('dgo', 'main', '%', { ac: '0.2%', sr: { ac: 'Finviz' } })], NOW);
  const cold = ev('dgo', 'main', '%');
  applyLedger([cold], mem, NOW);
  assert.equal(cold.ac, '0.2%');
});

test('the page shows no "was" pill; the opened release still says Corrected', () => {
  const html = readFileSync(new URL('../../news.html', import.meta.url), 'utf8');
  assert.ok(!html.includes("'was '+esc(e.wfix)"));
  assert.ok(html.includes("e.flag&&!e.wfix?"));
  assert.ok(html.includes('Corrected: \'+esc(e.flag)'));
});

test('an official figure restored from the ledger settles the wire figure and its Finviz note (seen in the 25 Nov replay)', () => {
  const mem = newLedger();
  recordLedger(mem, [ev('pce', 'yoy', '%', { ac: '3.3%', sr: { ac: 'FRED' } })], NOW);
  const e = ev('pce', 'yoy', '%', { ac: '3.1%', sr: { ac: 'FJ' }, flag: 'FinancialJuice said 3.1%, Finviz says 3.3%; showing 3.1%' });
  applyLedger([e], mem, NOW);
  assert.equal(e.ac, '3.3%'); assert.equal(e.wfix, '3.1%');
  assert.match(e.flag, /showing 3\.3%$/);
  const same = ev('pce', 'yoy', '%', { ac: '3.3%', sr: { ac: 'FJ' }, cf: 'Finviz' });
  applyLedger([same], mem, NOW);
  assert.equal(same.flag, undefined); assert.equal(same.cf, undefined);
});
