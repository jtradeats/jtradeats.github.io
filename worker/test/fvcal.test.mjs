// node --test worker/test/fvcal.test.mjs   (Finviz economic calendar, plan P8.44)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand, overlay, etToMs, etParts, candidates, normFair } from '../src/schedule.js';
import { parseFvCal, normFv, fvToken, fvOverlayRows, applyFvActuals, mondayOf } from '../src/fvcal.js';
import { rankOf, newLedger, recordLedger, applyLedger } from '../src/ledger.js';
import { applyOfficial } from '../src/official.js';

const J = f => JSON.parse(readFileSync(new URL('../config/' + f, import.meta.url)));
const SCHED = J('schedule.json'), IND = J('indicators.json');
const ev = expand(SCHED, IND);

// The markup of one event row and one day table, as the 25 Nov probe showed them (same cell order and classes; "-" is a muted span).
const cell = v => (v == null ? '<span class="text-muted-2">-</span>' : v);
const row = (id, time, title, per, ac, exp, prior) =>
  `<tr class="styled-row is-bordered is-hover-borders is-rounded cursor-pointer group is-hoverable is-rounded" id="event-${id}">` +
  `<td class="w-22 h-6 py-0 px-1 leading-tight text-right"><div class="flex w-full flex-row items-center justify-between"><svg class="pointer-events-none"><use href="/assets/dist-icons/icons.1f7da9e4.svg#chevronRight"></use></svg><div class="whitespace-nowrap text-muted">${time}</div></div></td>` +
  `<td class="h-6 py-0 px-1 leading-tight"><span class="whitespace-nowrap">${title}</span></td>` +
  `<td class="w-28 h-6 py-0 px-1 leading-tight"><svg class="pointer-events-none"><use href="/assets/dist-icons/icons_calendar.143741ba.svg#impactMediumSev3"></use></svg></td>` +
  `<td class="w-22 h-6 py-0 px-1 leading-tight"><div>${per}</div></td>` +
  `<td class="w-28 h-6 py-0 px-1 leading-tight text-right">${cell(ac)}</td><td class="w-28 h-6 py-0 px-1 leading-tight text-right">${cell(exp)}</td><td class="w-28 h-6 py-0 px-1 leading-tight text-right">${cell(prior)}</td>` +
  `<td class="w-14 h-6 py-0 px-1 leading-tight text-right"><div class="flex justify-end"><button aria-expanded="false"><span class="flex w-3"><svg><use href="#bellOutlined"></use></svg></span></button></div></td></tr>`;
const day = (dow, label, rows) =>
  `<table class="w-full"><thead><tr class="bg-inherit"><th class="w-22 sticky sticky-0 text-right px-1 whitespace-nowrap"><span class="font-semibold">${dow}</span> <span>${label}</span></th>` +
  `<th class="sticky text-left">Release</th><th class="sticky">Impact</th><th class="sticky">For</th><th class="sticky text-right">Actual</th><th class="sticky text-right">Expected</th><th class="sticky text-right">Prior</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;

// Wednesday 25 Nov as Finviz showed it on 25 Nov (the probe's figures), Monday and Tuesday as released
const PAGE = '<html><body>' +
  day('Mon', 'Nov 23', [row(1, '9:45 AM', 'S&amp;P Global Services PMI Flash', 'Nov', '54.7', '55.6', '56.1')]) +
  day('Tue', 'Nov 24', [row(2, '10:00 AM', 'CB Consumer Confidence', 'Nov', '103.3', '92.5', '91.9'), row(3, '4:30 PM', 'API Crude Oil Stock Change', 'Nov 21', null, '0.9M', '5.3M')]) +
  day('Wed', 'Nov 25', [
    row(398221, '8:30 AM', 'Core PCE Price Index YoY', 'Oct', null, '3.2%', '3.1%'),
    row(397919, '8:30 AM', 'Core PCE Prices QoQ 2nd Est', 'Q3', null, '2.5%', '3.3%'),
    row(399154, '8:30 AM', 'Durable Goods Orders MoM', 'Oct', null, '0.4%', '1.9%'),
    row(398069, '8:30 AM', 'GDP Growth Rate QoQ 2nd Est', 'Q3', null, '3.4%', '2.2%'),
    row(398070, '8:30 AM', 'GDP Price Index QoQ 2nd Est', 'Q3', null, '2.3%', '2.1%'),
    row(400001, '8:30 AM', 'Initial Jobless Claims', 'Nov 22', null, '200K', '203K'),
    row(400002, '8:30 AM', 'Jobless Claims 4-week Average', 'Nov 22', null, '207K', '206K'),
    row(398682, '10:00 AM', 'New Home Sales', 'Oct', null, '0.65M', '0.676M'),
    row(398181, '10:00 AM', 'New Home Sales MoM', 'Oct', null, null, '-0.6%'),
    row(400003, '10:30 AM', 'EIA Crude Oil Stocks Change', 'Nov 21', null, null, '3.38M'),
    row(400004, '10:30 AM', 'EIA Cushing Crude Oil Stocks Change', 'Nov 21', null, '0.2M', '1.1M'),
  ]) + '</body></html>';

const rows = parseFvCal(PAGE, '2026-11-23');
const fv = normFv(rows, IND);
const by = (list, title) => list.find(r => r.title === title);

test('parser: one row per event, New York time, "-" is no number', () => {
  assert.equal(rows.length, 14);
  const pce = by(rows, 'Core PCE Price Index YoY');
  assert.equal(pce.t, etToMs('2026-11-25T08:30'));
  assert.equal(pce.ac, null); assert.equal(pce.fc, '3.2%'); assert.equal(pce.pv, '3.1%'); assert.equal(pce.per, 'Oct');
  assert.equal(by(rows, 'New Home Sales').t, etToMs('2026-11-25T10:00'));
  assert.equal(by(rows, 'S&P Global Services PMI Flash').title, 'S&P Global Services PMI Flash');   // &amp; decoded
  assert.equal(by(rows, 'CB Consumer Confidence').ac, '103.3');
  assert.equal(by(rows, 'API Crude Oil Stock Change').t, etToMs('2026-11-24T16:30'));
});

test('parser: a week that crosses New Year, a row without a clock time, and junk', () => {
  const p = parseFvCal(day('Wed', 'Dec 30', [row(1, '8:30 AM', 'Initial Jobless Claims', 'Dec 26', null, '210K', '208K')]) + day('Fri', 'Jan 1', [row(2, 'All Day', 'New Year', '', null, null, null)]), '2026-12-28');
  assert.equal(p[0].t, etToMs('2026-12-30T08:30'));
  assert.equal(p[1].t, etToMs('2027-01-01T12:00'));   // year rolled over, noon for "All Day"
  assert.deepEqual(parseFvCal('<html>nothing here</html>', '2026-11-23'), []);
  assert.deepEqual(parseFvCal('', '2026-11-23'), []);
  assert.equal(fvToken('4.25-4.50%'), null);
  assert.deepEqual(fvToken('-0.6%'), { n: -0.6, s: '%' });
  assert.deepEqual(fvToken('1,234K'), { n: 1234, s: 'K' });
  assert.equal(fvToken('-'), null);
});

test('normFv: the units of the dashboard row, and only rows the dashboard shows', () => {
  assert.equal(by(fv, 'New Home Sales').fc, '650K');            // Finviz 0.65M, the row is in K
  assert.equal(by(fv, 'New Home Sales').pv, '676K');
  assert.equal(by(fv, 'Initial Jobless Claims').fc, '200K');
  assert.equal(by(fv, 'Core PCE Price Index YoY').fc, '3.2%');
  assert.equal(by(fv, 'CB Consumer Confidence').ac, '103.3');
  assert.equal(by(fv, 'GDP Growth Rate QoQ 2nd Est').fc, '3.4%');
  assert.equal(by(fv, 'EIA Crude Oil Stocks Change').pv, '3.380M');   // three decimals, as the reference calendar shows crude
  assert.ok(fv.every(r => r.imp === 1), 'imp 1: never an "extras" line, never a feed_date warning');
  // rows that must not land on a dashboard row
  for (const t of ['New Home Sales MoM', 'GDP Price Index QoQ 2nd Est', 'Core PCE Prices QoQ 2nd Est', 'Jobless Claims 4-week Average', 'EIA Cushing Crude Oil Stocks Change', 'API Crude Oil Stock Change', 'S&P Global Services PMI Flash'.replace('Flash', 'Flash x')]) assert.equal(by(fv, t), undefined, t);
  // a number in a unit that does not fit the row is dropped, not shown wrong
  const odd = normFv(parseFvCal(day('Wed', 'Nov 25', [row(9, '8:30 AM', 'Core PCE Price Index YoY', 'Oct', null, '0.65M', '3.1%')]), '2026-11-23'), IND);
  assert.equal(odd[0].fc, null); assert.equal(odd[0].pv, '3.1%');
});

test('title patterns: a different figure with a similar name cannot take a dashboard row (the 2.3% GDP forecast of 25 Nov)', () => {
  const k = t => [...new Set(candidates(IND, t).map(c => c.k + '|' + c.r))];   // two patterns of one row list it twice
  assert.deepEqual(k('Prelim GDP q/q'), ['gdp|main']);
  assert.deepEqual(k('Prelim GDP Price Index q/q'), []);        // Forex Factory's second GDP line: 2.3% was the price index forecast
  assert.deepEqual(k('Final GDP Price Index q/q'), []);
  assert.deepEqual(k('GDP Growth Rate QoQ 2nd Est'), ['gdp|main']);
  assert.deepEqual(k('GDP Price Index QoQ 2nd Est'), []);
  assert.deepEqual(k('New Home Sales'), ['nhs|main']);
  assert.deepEqual(k('New Home Sales MoM'), []);
  assert.deepEqual(k('Existing Home Sales MoM'), []);
  assert.deepEqual(k('Non Farm Payrolls'), ['nfp|nfp']);
  assert.deepEqual(k('Non Farm Payrolls Private'), []);
  assert.deepEqual(k('Non-Farm Employment Change'), ['nfp|nfp']);
  assert.deepEqual(k('Unemployment Claims'), ['claims|main']);
  assert.deepEqual(k('Initial Jobless Claims'), ['claims|main']);
  assert.deepEqual(k('Jobless Claims 4-week Average'), []);
  assert.deepEqual(k('EIA Crude Oil Stocks Change'), ['eia|main']);
  assert.deepEqual(k('EIA Cushing Crude Oil Stocks Change'), []);
  assert.deepEqual(k('Crude Oil Inventories'), ['eia|main']);
  assert.deepEqual(k('Retail Sales Ex Autos MoM'), ['retail|core']);
  assert.deepEqual(k('Retail Sales MoM'), ['retail|main']);
});

// 25 Nov, as the dashboard stood: Forex Factory's copy held claims, a GDP line, core PCE m/m (and the GDP price index line that overwrote the GDP forecast)
const week = ev.filter(e => e.t >= etToMs('2026-11-22T00:00') && e.t < etToMs('2026-11-29T00:00'));
const NOW = etToMs('2026-11-24T21:19');
const FF = normFair([
  { date: '2026-11-25T08:30:00-05:00', title: 'Unemployment Claims', country: 'USD', impact: 'High', forecast: '201K', previous: '203K' },
  { date: '2026-11-25T08:30:00-05:00', title: 'Prelim GDP q/q', country: 'USD', impact: 'High', forecast: '', previous: '2.2%' },
  { date: '2026-11-25T08:30:00-05:00', title: 'Prelim GDP Price Index q/q', country: 'USD', impact: 'Medium', forecast: '2.3%', previous: '2.1%' },
  { date: '2026-11-25T08:30:00-05:00', title: 'Core PCE Price Index m/m', country: 'USD', impact: 'High', forecast: '0.3%', previous: '0.3%' },
], IND);

test('overlay: Finviz fills what Forex Factory lacks, Forex Factory wins where both have a number', () => {
  const o = overlay(week, [{ name: 'Finviz', rows: fvOverlayRows(fv), noTime: true }, { name: 'Fair Economy', rows: FF }], IND, NOW);
  const g = id => o.events.find(e => e.id === id);
  assert.equal(g('pce|2026-11-25|yoy').fc, '3.2%');             // no Forex Factory row at all
  assert.equal(g('pce|2026-11-25|yoy').sr.fc, 'Finviz');
  assert.equal(g('dgo|2026-11-25|main').fc, '0.4%');
  assert.equal(g('nhs|2026-11-25|main').fc, '650K');
  assert.equal(g('claims|2026-11-25|main').fc, '201K');          // Forex Factory 201K over Finviz 200K
  assert.equal(g('claims|2026-11-25|main').sr.fc, 'Fair Economy');
  assert.equal(g('gdp|2026-11-25|main').fc, '3.4%');             // not 2.3%
  assert.equal(g('gdp|2026-11-25|main').sr.fc, 'Finviz');
  assert.equal(g('gdp|2026-11-25|main').pv, null);               // second estimate: neither feed's previous is used (P8.37)
  assert.equal(g('cb|2026-11-24|main').pv, '91.9');              // the revised previous
  assert.equal(o.extras, 0);
  assert.ok(!o.issues.some(i => i.code === 'feed_time' || i.code === 'feed_date'), JSON.stringify(o.issues));
});

test('overlay: the second-estimate GDP row keeps its own previous (P8.37), Finviz does not replace it', () => {
  const o = overlay(week, [{ name: 'Finviz', rows: fvOverlayRows(fv), noTime: true }], IND, NOW);
  const g = o.events.find(e => e.id === 'gdp|2026-11-25|main');
  assert.equal(g.pv, null);                                      // none typed here; the typed 3.4% comes from results.json, the feed's 2.2% is not used
});

test('overlay: Finviz never supplies an actual (fvOverlayRows drops it, the same array is reused)', () => {
  const r = fvOverlayRows(fv);
  assert.ok(r.every(x => x.ac === null));
  assert.equal(r, fvOverlayRows(fv));
  const o = overlay(week, [{ name: 'Finviz', rows: r, noTime: true }], IND, NOW);
  assert.equal(o.events.find(e => e.id === 'cb|2026-11-24|main').ac, null);
});

test('overlay: without noTime a Finviz clock time would be compared; with it never', () => {
  const shifted = [{ t: etToMs('2026-11-25T08:45'), title: 'Core PCE Price Index YoY', imp: 1, fc: '3.2%', pv: null, ac: null }];
  assert.ok(overlay(week, [{ name: 'Finviz', rows: shifted }], IND, NOW).issues.some(i => i.code === 'feed_time'));
  assert.ok(!overlay(week, [{ name: 'Finviz', rows: shifted, noTime: true }], IND, NOW).issues.some(i => i.code === 'feed_time'));
});

const AFTER = etToMs('2026-11-24T10:20');
const mk = (id, extra) => {
  const e = { ...ev.find(x => x.id === id), fc: null, pv: null, ac: null, ...extra };
  return e;
};

test('actuals: a blank actual is filled, tagged Finviz', () => {
  const e = mk('cb|2026-11-24|main');
  const r = applyFvActuals([e], fv, IND, AFTER);
  assert.equal(e.ac, '103.3'); assert.equal(e.sr.ac, 'Finviz'); assert.equal(r.n, 1);
});

test('actuals: a typed placeholder within 3 days is replaced, an older one is left alone', () => {
  const e = mk('cb|2026-11-24|main', { ac: '99.0', sr: { ac: 'ref' } });
  applyFvActuals([e], fv, IND, AFTER);
  assert.equal(e.ac, '103.3');
  const old = mk('cb|2026-11-24|main', { ac: '99.0', sr: { ac: 'ref' } });
  applyFvActuals([old], fv, IND, etToMs('2026-11-30T12:00'));
  assert.equal(old.ac, '99.0');
});

test('actuals: the wire\'s figure is confirmed when Finviz agrees, flagged and kept when it does not', () => {
  const same = mk('cb|2026-11-24|main', { ac: '103.3', sr: { ac: 'FJ' } });
  const r1 = applyFvActuals([same], fv, IND, AFTER);
  assert.equal(same.cf, 'Finviz'); assert.equal(same.sr.ac, 'FJ'); assert.equal(same.ac, '103.3'); assert.equal(r1.confirmed, 1); assert.equal(same.flag, undefined);
  const diff = mk('cb|2026-11-24|main', { ac: '130.3', sr: { ac: 'FJ' } });
  const r2 = applyFvActuals([diff], fv, IND, AFTER);
  assert.equal(diff.ac, '130.3'); assert.equal(diff.cf, undefined);
  assert.match(diff.flag, /FinancialJuice said 130.3, Finviz says 103.3; showing 130.3/);
  assert.equal(r2.issues[0].code, 'wire_finviz_diff');
});

test('actuals: nothing before the release time, nothing for a row Finviz has no actual for', () => {
  const e = mk('cb|2026-11-24|main');
  applyFvActuals([e], fv, IND, etToMs('2026-11-24T09:00'));
  assert.equal(e.ac, null);
  const p = mk('pce|2026-11-25|yoy');
  applyFvActuals([p], fv, IND, etToMs('2026-11-25T09:00'));
  assert.equal(p.ac, null);
});

test('official: a Finviz first figure is settled by the official series like a wire one, and stays out of the wire agreement log', () => {
  const t = etToMs('2026-11-19T08:30');
  const e = { ...ev.find(x => x.id === 'claims|2026-11-19|main'), ac: '204K', sr: { ac: 'Finviz' } };
  const M = { ICSA: new Map([['2026-11-14', 203000]]) };
  const r = applyOfficial([e], M, t + 3600e3, {});
  assert.equal(e.ac, '203K'); assert.equal(e.sr.ac, 'FRED'); assert.equal(e.wfix, '204K');
  assert.match(e.flag, /^Finviz said 204K/);
  assert.equal(r.wire.length, 0);
  const f = { ...ev.find(x => x.id === 'claims|2026-11-19|main'), ac: '204K', sr: { ac: 'FJ' } };
  assert.equal(applyOfficial([f], M, t + 3600e3, {}).wire.length, 1);
});

test('ledger: Finviz ranks between the wire and the calendar feed, and its figures survive a cold start', () => {
  assert.ok(rankOf('FJ') < rankOf('Finviz') && rankOf('Finviz') < rankOf('Fair Economy') && rankOf('Finviz') < rankOf('FRED'));
  const mem = newLedger();
  const live = mk('cb|2026-11-24|main', { ac: '103.3', fc: '92.5', sr: { ac: 'Finviz', fc: 'Finviz' } });
  const up = mk('dgo|2026-11-25|main', { fc: '0.4%', sr: { fc: 'Finviz' } });
  assert.equal(recordLedger(mem, [live, up], AFTER), true);
  const cold = [mk('cb|2026-11-24|main'), mk('dgo|2026-11-25|main')];
  assert.equal(applyLedger(cold, mem, AFTER) > 0, true);
  assert.equal(cold[0].ac, '103.3'); assert.equal(cold[0].sr.ac, 'Finviz'); assert.equal(cold[1].fc, '0.4%');
  // a forecast Forex Factory gave is not displaced by Finviz's in the ledger
  const m2 = newLedger();
  recordLedger(m2, [mk('claims|2026-11-25|main', { fc: '201K', sr: { fc: 'Fair Economy' } })], AFTER);
  const c2 = [mk('claims|2026-11-25|main', { fc: '200K', sr: { fc: 'Finviz' } })];
  applyLedger(c2, m2, AFTER);
  assert.equal(c2[0].fc, '201K');
});

test('mondayOf: the Monday of the New York week', () => {
  assert.equal(mondayOf(etToMs('2026-11-25T02:00')), '2026-11-23');   // Wednesday
  assert.equal(mondayOf(etToMs('2026-11-23T00:30')), '2026-11-23');   // Monday
  assert.equal(mondayOf(etToMs('2026-11-29T20:00')), '2026-11-23');   // Sunday
  assert.equal(etParts(etToMs('2026-11-25T08:30')).iso, '2026-11-25');
});

test('crude: Forex Factory\'s rounded previous (3.4M) does not hide the three decimals Finviz gives (3.380M); 25 Nov screenshot', () => {
  const ffCrude = normFair([{ date: '2026-11-25T10:30:00-05:00', title: 'Crude Oil Inventories', country: 'USD', impact: 'Low', forecast: '2M', previous: '3.4M' }], IND);
  const o = overlay(week, [{ name: 'Finviz', rows: fvOverlayRows(fv), noTime: true }, { name: 'Fair Economy', rows: ffCrude }], IND, NOW);
  const c = o.events.find(e => e.id === 'eia|2026-11-25|main');
  assert.equal(c.pv, '3.380M'); assert.equal(c.sr.pv, 'Finviz');
  assert.equal(c.fc, '2.000M'); assert.equal(c.sr.fc, 'Fair Economy');   // the forecast is Forex Factory's: Finviz has none for crude
});

// ---- 25 Nov live release: the "awaiting official figure" label, and the wire's durable goods wording
import { markPending, PENDING_GRACE } from '../src/official.js';
import { parseWire, WIRE_KEYS } from '../src/wire.js';
import { fvDue, FV_SLOW, FV_FAST, FV_NEXT, FV_RETRY } from '../src/fvcal.js';

test('awaiting label: a row the wire covers gets none for its first 10 minutes; a row it does not cover gets it at once', () => {
  const t = etToMs('2026-11-25T08:30');
  const mkc = id => ({ ...ev.find(x => x.id === id), ac: null });
  const wireCovered = e => WIRE_KEYS.has(e.k + '|' + e.r);
  const a = [mkc('claims|2026-11-25|main'), mkc('gdp|2026-11-25|main')];
  assert.equal(markPending(a, t + 2 * 60e3, wireCovered).length, 0);              // +2 min: blank, the wire's figure is coming
  assert.ok(!a[0].aw && !a[1].aw);
  assert.equal(markPending(a, t + PENDING_GRACE + 1000, wireCovered).length, 2);  // +10 min and still nothing: say so
  assert.equal(a[0].aw, 1);
  const noWire = [mkc('claims|2026-11-25|main')];
  assert.equal(markPending(noWire, t + 60e3, () => false).length, 1);             // not covered by the wire: labelled at once, as before
  assert.equal(markPending([mkc('claims|2026-11-25|main')], t + 60e3).length, 1); // no covered() given: unchanged behaviour
});

test('wire: durable goods wording variants fill the row, the ex-transport line does not', () => {
  for (const name of ['DURABLE GOODS ORDERS MOM', 'DURABLE GOODS ORDERS', 'DURABLE GOODS MOM', 'DURABLE GOODS']) {
    const x = parseWire(`US ${name} ACTUAL 0.2% (FORECAST 0.6%, PREVIOUS 2.9%) $MACRO`);
    assert.deepEqual(x.rule && x.rule.keys, ['dgo|main'], name);
  }
  assert.equal(parseWire('US DURABLE GOODS ORDERS EX TRANSPORTATION MOM ACTUAL 0.4% (FORECAST 0.3%, PREVIOUS 0.5%) $MACRO').rule, null);
  assert.equal(parseWire('US CORE DURABLE GOODS ORDERS MOM ACTUAL 0.4% (FORECAST 0.3%, PREVIOUS 0.5%) $MACRO').rule, null);
});

test('refresh plan: one page per invocation, this week first, next week every 2 hours, a failure backs off', () => {
  const now = 1e12, ok = { events: [{}], at: now - 60e3, nxtAt: now - 60e3, failAt: 0 };
  assert.equal(fvDue({ events: null, at: 0, nxtAt: 0, failAt: 0 }, now, false), 'cur');
  assert.equal(fvDue(ok, now, false), null);
  assert.equal(fvDue({ ...ok, at: now - FV_SLOW - 1 }, now, false), 'cur');
  assert.equal(fvDue({ ...ok, at: now - FV_FAST - 1 }, now, true), 'cur');       // a release window: every 5 minutes
  assert.equal(fvDue({ ...ok, at: now - FV_FAST - 1 }, now, false), null);       // quiet hours: not yet
  assert.equal(fvDue({ ...ok, nxtAt: now - FV_NEXT - 1 }, now, false), 'nxt');   // this week is fresh: next week's page
  assert.equal(fvDue({ ...ok, nxtAt: now - FV_NEXT - 1 }, now, true), null);      // never next week in a release window
  assert.equal(fvDue({ ...ok, at: now - FV_SLOW - 1, nxtAt: now - FV_NEXT - 1 }, now, false), 'cur');   // this week wins when both are due
  assert.equal(fvDue({ events: null, at: 0, nxtAt: 0, failAt: now - 60e3 }, now, false), null);          // just failed
  assert.equal(fvDue({ events: null, at: 0, nxtAt: 0, failAt: now - FV_RETRY - 1 }, now, false), 'cur');
});

import { unmatchedUsNames } from '../src/wire.js';
test('wire: FinancialJuice\'s "NEW HOME SALES - UNITS" fills the row in K; the MoM post and foreign posts do not', () => {
  const u = parseWire('US NEW HOME SALES - UNITS ACTUAL 0.701M (FORECAST 0.65M, PREVIOUS 0.676M) $MACRO');
  assert.deepEqual(u.rule.keys, ['nhs|main']);
  assert.equal(parseWire('US NEW HOME SALES CHANGE MOM ACTUAL 14.2% (FORECAST -3.8%, PREVIOUS -0.6%) $MACRO').rule, null);
  assert.equal(parseWire('AUSTRALIAN CPI YOY NSA ACTUAL 4.9% (FORECAST 4.7%, PREVIOUS 4.3%) $MACRO').rule, null);
});
test('wire: unmatchedUsNames lists each unknown US release once, newest first, and skips known rows and other countries', () => {
  const posts = [
    { t: 3, text: 'US DURABLES NEW ORDERS ACTUAL 0.2% (FORECAST 0.6%, PREVIOUS 2.9%) $MACRO' },
    { t: 2, text: 'US DURABLES NEW ORDERS ACTUAL 0.2% (FORECAST 0.6%, PREVIOUS 2.9%) $MACRO' },
    { t: 4, text: 'US INITIAL JOBLESS CLAIMS ACTUAL 189K (FORECAST 201K, PREVIOUS 203K) $MACRO' },
    { t: 5, text: 'AUSTRALIAN CPI YOY NSA ACTUAL 4.9% (FORECAST 4.7%, PREVIOUS 4.3%) $MACRO' },
    { t: 6, text: 'US NEW HOME SALES CHANGE MOM ACTUAL 14.2% (FORECAST -3.8%, PREVIOUS -0.6%) $MACRO' },
    { t: 7, text: 'US 5 Yr Note Auction High Yield 4.719% [Tail of 0.3 BPS] Bid-to-cover 2.37' },
  ];
  const r = unmatchedUsNames(posts);
  assert.deepEqual(r.map(x => x.name), ['NEW HOME SALES CHANGE MOM', 'DURABLES NEW ORDERS']);
  assert.equal(unmatchedUsNames(null).length, 0);
});
