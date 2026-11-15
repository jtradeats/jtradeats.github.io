// node --test worker/test/calendar.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand, audit, overlay, etToMs, normFair, normFmp, fmtVal, applyResults, chainPrevious, candidates } from '../src/schedule.js';

const J = f => JSON.parse(readFileSync(new URL('../config/' + f, import.meta.url)));
const SCHED = J('schedule.json'), IND = J('indicators.json'), RES = J('results.json');
const NOW = etToMs('2026-11-14T12:00');   // Saturday, the reference date
const ev = expand(SCHED, IND);
const by = id => ev.find(e => e.id === id);

test('one schedule line expands into the rows of its kind', () => {
  assert.equal(ev.filter(e => e.k === 'nfp' && e.d === '2026-12-04').length, 3);
  assert.deepEqual(ev.filter(e => e.k === 'fomc' && e.d === '2026-12-09').map(e => e.title), ['Fed Interest Rate Decision', 'FOMC Statement', 'FOMC Press Conference']);
  assert.equal(by('fomc|2026-12-09|pc').t - by('fomc|2026-12-09|dec').t, 30 * 60000);
  assert.equal(by('cpi|2026-12-10|yoy').title, 'CPI (YoY) (Nov)');
  assert.equal(by('gdp|2026-11-25|main').title, 'GDP (QoQ) (Q3)');
  assert.equal(by('gdp|2026-11-25|main').imp, 3);
  assert.equal(by('minutes|2026-11-18|main').title, 'FOMC Meeting Minutes');
  assert.equal(by('speech|2026-11-16|main').title, 'Fed Chair Warsh Speaks');
  assert.equal(by('hol|2026-11-26|main').ad, 1);
  assert.equal(by('hol|2026-11-27|main').ad, 2);
});

test('every event of the reference calendar is present (titles, dates, times in New York)', () => {
  const want = [  // [date, time, title]
    ['2026-11-02','09:45','S&P Global Manufacturing PMI (Oct)'],['2026-11-02','10:00','ISM Manufacturing PMI (Oct)'],['2026-11-02','10:00','ISM Manufacturing Prices (Oct)'],
    ['2026-11-03','10:00','JOLTS Job Openings (Sep)'],['2026-11-04','08:15','ADP Nonfarm Employment Change (Oct)'],['2026-11-04','09:45','S&P Global Services PMI (Oct)'],
    ['2026-11-04','10:00','ISM Non-Manufacturing Prices (Oct)'],['2026-11-04','10:00','ISM Non-Manufacturing PMI (Oct)'],['2026-11-04','10:30','Crude Oil Inventories'],
    ['2026-11-05','08:30','Initial Jobless Claims'],['2026-11-06','08:30','Nonfarm Payrolls (Oct)'],['2026-11-06','08:30','Unemployment Rate (Oct)'],['2026-11-06','08:30','Average Hourly Earnings (MoM) (Oct)'],
    ['2026-11-10','08:30','CPI (MoM) (Oct)'],['2026-11-10','08:30','Core CPI (MoM) (Oct)'],['2026-11-10','13:00','10-Year Note Auction'],
    ['2026-11-12','08:30','Initial Jobless Claims'],['2026-11-12','10:00','Existing Home Sales (Oct)'],['2026-11-12','12:00','Crude Oil Inventories'],['2026-11-12','13:00','30-Year Bond Auction'],
    ['2026-11-13','08:30','PPI (MoM) (Oct)'],['2026-11-16','12:00','Fed Chair Warsh Speaks'],['2026-11-17','08:30','Retail Sales (MoM) (Oct)'],['2026-11-17','08:30','Core Retail Sales (MoM) (Oct)'],
    ['2026-11-18','10:30','Crude Oil Inventories'],['2026-11-18','14:00','FOMC Meeting Minutes'],['2026-11-19','08:30','Philadelphia Fed Manufacturing Index (Nov)'],['2026-11-19','08:30','Initial Jobless Claims'],
    ['2026-11-23','09:45','S&P Global Services PMI (Nov)'],['2026-11-23','09:45','S&P Global Manufacturing PMI (Nov)'],['2026-11-24','10:00','CB Consumer Confidence (Nov)'],
    ['2026-11-25','08:30','Core PCE Price Index (MoM) (Oct)'],['2026-11-25','08:30','Core PCE Price Index (YoY) (Oct)'],['2026-11-25','08:30','GDP (QoQ) (Q3)'],['2026-11-25','08:30','Durable Goods Orders (MoM) (Oct)'],['2026-11-25','10:00','New Home Sales (Oct)'],
    ['2026-11-26','00:00','United States - Thanksgiving Day'],['2026-11-27','00:00','United States - Thanksgiving Day - Early close at 13:00'],['2026-11-30','09:45','Chicago PMI (Nov)'],
    ['2026-12-01','09:45','S&P Global Manufacturing PMI (Nov)'],['2026-12-01','10:00','ISM Manufacturing PMI (Nov)'],['2026-12-01','10:00','JOLTS Job Openings (Oct)'],['2026-12-02','08:15','ADP Nonfarm Employment Change (Nov)'],
    ['2026-12-03','09:45','S&P Global Services PMI (Nov)'],['2026-12-03','10:00','ISM Non-Manufacturing PMI (Nov)'],['2026-12-04','08:30','Nonfarm Payrolls (Nov)'],['2026-12-04','08:30','Unemployment Rate (Nov)'],['2026-12-04','08:30','Average Hourly Earnings (MoM) (Nov)'],
    ['2026-12-09','14:00','Fed Interest Rate Decision'],['2026-12-09','14:00','FOMC Statement'],['2026-12-09','14:30','FOMC Press Conference'],
  ];
  for (const [d, t, title] of want) assert.ok(ev.some(e => e.d === d && e.title === title && etToMs(`${d}T${t}`) === e.t), `${d} ${t} ${title}`);
});

test('FOMC 2027 follows the Fed\'s revised schedule: no December meeting, 27 Oct is strategy only', () => {
  const dec = ev.filter(e => e.k === 'fomc' && e.r === 'dec').map(e => e.d).filter(d => d.startsWith('2027'));
  assert.deepEqual(dec, ['2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-11-17']);
  assert.ok(by('fomc_s|2027-10-27|main'));
});

test('the schedule file passes its own audit with no errors', () => {
  const a = audit(SCHED, IND, NOW);
  const errs = a.issues.filter(i => i.lvl === 'error');
  assert.deepEqual(errs, [], JSON.stringify(errs, null, 1));
  assert.notEqual(a.status, 'error');
  console.log('audit notes:', a.nIssues, a.issues.map(i => i.code + ' ' + (i.k || '')).join(', '));
});

test('audit catches a wrong time, a weekend date and a doubled month', () => {
  const bad = { ...SCHED, releases: SCHED.releases.concat([
    { d: '2026-12-08', t: '09:00', k: 'adp' }, { d: '2026-12-12', t: '08:30', k: 'ppi' }, { d: '2026-12-16', t: '08:30', k: 'ppi', p: 'Nov' }]) };
  const codes = audit(bad, IND, NOW).issues.map(i => i.code);
  assert.ok(codes.includes('time') && codes.includes('weekend') && codes.includes('extra'), codes.join());
});

test('results.json keys all exist in the schedule', () => {
  const ids = new Set(ev.map(e => e.id));
  for (const k of Object.keys(RES.rows)) assert.ok(ids.has(k), 'unknown key ' + k);
});

test('hand-typed results fill the columns, win over a provider, and chain to the next previous', () => {
  const win = ev.filter(e => e.t > NOW - 31 * 864e5 && e.t < NOW + 60 * 864e5);
  const o = overlay(win, [{ name: 'Fair Economy', rows: [{ t: etToMs('2026-11-17T08:30'), title: 'Retail Sales m/m', imp: 3, fc: '0.3%', pv: '0.7%', ac: null }] }], IND, NOW);
  assert.equal(o.matched, 1);
  applyResults(o.events, RES);
  chainPrevious(o.events);
  const g = id => o.events.find(e => e.id === id);
  assert.equal(g('retail|2026-11-17|main').fc, '0.0%');        // typed value beats the feed
  assert.equal(g('retail|2026-11-17|main').pv, '0.8%');
  assert.equal(g('cpi|2026-11-10|mom').ac, '0.4%');
  assert.equal(g('claims|2026-11-12|main').pvc, 'r');
  assert.equal(g('ppi|2026-12-15|mom').pv, '0.3%');            // carried from 13 Nov
  assert.equal(g('ppi|2026-12-15|mom').sr.pv, 'last release');
});

test('provider rows: Forex Factory titles and FMP numbers map to rows with units applied', () => {
  const fair = normFair([{ date: '2026-11-17T08:30:00-05:00', country: 'USD', impact: 'High', title: 'Core Retail Sales m/m', forecast: '0.4%', previous: '0.9%' },
    { date: '2026-11-17T08:30:00-05:00', country: 'EUR', impact: 'High', title: 'x' }]);
  assert.equal(fair.length, 1);
  const fmp = normFmp([
    { date: '2026-11-19 13:30:00', country: 'US', event: 'Initial Jobless Claims', previous: 200000, estimate: 205000, actual: null, impact: 'High' },
    { date: '2026-11-25 13:30:00', country: 'US', event: 'Core PCE Price Index MoM (Oct)', previous: 0.3, estimate: 0.3, actual: 0.4, impact: 'High' },
    { date: '2026-11-25 13:30:00', country: 'US', event: 'GDP Growth Rate QoQ 2nd Est (Q3)', previous: 3.4, estimate: 3.2, actual: 3.5, impact: 'High' },
    { date: '2026-11-25 13:30:00', country: 'DE', event: 'foo', impact: 'High' }]);
  assert.equal(fmp.length, 3);
  const win = ev.filter(e => e.t > NOW - 864e5 && e.t < NOW + 30 * 864e5);
  const o = overlay(win, [{ name: 'Fair Economy', rows: fair }, { name: 'FMP', rows: fmp }], IND, NOW);
  const g = id => o.events.find(e => e.id === id);
  assert.equal(g('claims|2026-11-19|main').fc, '205K');
  assert.equal(g('pce|2026-11-25|mom').ac, '0.4%');
  assert.equal(g('gdp|2026-11-25|main').fc, '3.2%');
  assert.equal(g('retail|2026-11-17|core').fc, '0.4%');
  assert.equal(g('pce|2026-11-25|mom').sr.ac, 'FMP');
});

test('a provider date that disagrees with the schedule is flagged, not trusted', () => {
  const win = ev.filter(e => e.t > NOW - 864e5 && e.t < NOW + 30 * 864e5);
  const o = overlay(win, [{ name: 'FMP', rows: [{ t: etToMs('2026-11-18T08:30'), title: 'Retail Sales MoM (Oct)', imp: 3, fc: 0.2 }] }], IND, NOW);
  assert.ok(o.issues.some(i => i.code === 'feed_date'));
  assert.equal(o.events.find(e => e.id === 'retail|2026-11-17|main').fc, null);
});

test('fmtVal scales provider numbers by unit', () => {
  assert.equal(fmtVal(0.3, '%'), '0.3%'); assert.equal(fmtVal(217000, 'K'), '217K'); assert.equal(fmtVal(165, 'K'), '165K');
  assert.equal(fmtVal(-865000, 'M'), '-0.865M'); assert.equal(fmtVal(3.75, 'M'), '3.75M'); assert.equal(fmtVal(54.9, ''), '54.9'); assert.equal(fmtVal('', '%'), null);
});

test('no row title is claimed by two different rows of the same kind', () => {
  for (const [k, ind] of Object.entries(IND.kinds)) for (const row of ind.rows) for (const m of row.match || []) {
    for (const other of ind.rows) if (other !== row && !(IND.kinds[k].rows.indexOf(other) < 0)) {
      const sample = row.t; // each row's own title must not match another row's patterns
      assert.ok(!(other.match || []).some(p => new RegExp(p, 'i').test(sample)) || k === 'spg_f', `${k}: "${sample}" also matches ${other.id}`);
    }
  }
  assert.deepEqual(candidates(IND, 'Core CPI m/m').map(c => c.r), ['core']);
});
