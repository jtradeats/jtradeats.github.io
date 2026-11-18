// node --test worker/test/schedule_sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand, audit, etToMs, normFmp } from '../src/schedule.js';
import {
  parseBls, runBls, runFred, parseFredDates, FRED_URL, parseTreasuryJson, parseTentative, runTreasury, classifyTreasury, parseDateLoose, refundingQuarter, tentUrl,
  providerLines, runProvider, lineKey, refYM, mergeSchedule, diffSchedules, syncIssues, syncSummary, dueSources, rank, checkLine,
} from '../src/schedule_sync.js';

const J = f => JSON.parse(readFileSync(new URL('../config/' + f, import.meta.url)));
const SCHED = J('schedule.json'), IND = J('indicators.json');
const NOW = etToMs('2026-11-15T09:00');   // Sunday, the day the sync was built
const TODAY = '2026-11-15';
const baseOf = k => SCHED.releases.filter(r => r.k === k);

// ---- fixtures ----
const ABBR = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const t12 = t => { const [h, m] = t.split(':').map(Number); return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
// a BLS "Schedule of Releases" page around a table, with the navigation noise of the real page; rows: [{p, d, t}]
function blsPage(rows, title = 'Consumer Price Index') {
  const tr = rows.map(r => { const ym = refYM(r.p, r.d), [y, m] = r.d.split('-').map(Number); return `<tr><td>${FULL[+ym.slice(5) - 1]} ${ym.slice(0, 4)}</td><td>${ABBR[m - 1]} ${+r.d.slice(8)}, ${y}</td><td>${t12(r.t)}</td></tr>`; }).join('\n');
  return `<html><head><title>Schedule of Releases for the ${title}</title></head><body><ul><li><a href="/x">Release Calendar</a></li><li>DECEMBER 2026</li></ul>
  <h2>Schedule of Releases for the ${title}</h2><table class="release-list"><thead><tr><th>Reference Month</th><th>Release Date </th><th>Release Time</th></tr></thead><tbody>${tr}</tbody></table>
  <p>Subscribe to the BLS Online Calendar. Copy and paste https://www.bls.gov/schedule/news_release/bls.ics into your calendar. October 2027 Nov. 10, 2027 08:30 AM</p></body></html>`;
}
const fromBase = (k, since = '2026-11-01') => baseOf(k).filter(r => r.d >= since).map(r => ({ p: r.p, d: r.d, t: r.t }));
const PPI_2027 = [['Dec', '2027-01-14'], ['Jan', '2027-02-12'], ['Feb', '2027-03-12'], ['Mar', '2027-04-14'], ['Apr', '2027-05-13']].map(([p, d]) => ({ p, d, t: '08:30' }));
const PAGES = () => ({
  cpi: blsPage(fromBase('cpi')), empsit: blsPage(fromBase('nfp'), 'Employment Situation'),
  ppi: blsPage([...fromBase('ppi'), ...PPI_2027], 'Producer Price Index'), jolts: blsPage(fromBase('jolts'), 'Job Openings and Labor Turnover'),
});
const fakeGet = (map, calls = []) => async url => {
  calls.push(url);
  for (const [frag, v] of Object.entries(map)) if (url.includes(frag)) { if (v instanceof Error) throw v; return typeof v === 'string' ? v : JSON.stringify(v); }
  throw new Error('HTTP 404 from fake');
};
const blsGet = (pages = PAGES()) => fakeGet(Object.fromEntries(Object.entries(pages).map(([p, h]) => [`/${p}.htm`, h])));

// Treasury: the 10-year and 30-year auctions of the Nov 2026 tentative schedule (as listed on 6 Nov) plus rows that must be ignored
const TENT = [
  ['3-Year', 'NOTE', '', '2026-12-07'], ['10-Year', 'NOTE', 'R', '2026-12-08'], ['30-Year', 'BOND', 'R', '2026-12-10'], ['20-Year', 'BOND', 'R', '2026-12-22'],
  ['5-Year', 'TIPS', 'R', '2026-12-23'], ['10-Year', 'TIPS', 'R', '2026-11-19'], ['13-Week', 'BILL', '', '2026-12-07'], ['2-Year', 'FRN', 'R', '2026-12-23'],
  ['10-Year', 'NOTE', 'R', '2027-01-12'], ['30-Year', 'BOND', 'R', '2027-01-13'], ['10-Year', 'NOTE', '', '2027-02-10'], ['30-Year', 'BOND', '', '2027-02-11'],
  ['10-Year', 'NOTE', 'R', '2027-03-10'], ['30-Year', 'BOND', 'R', '2027-03-11'], ['10-Year', 'NOTE', 'R', '2027-04-12'], ['30-Year', 'BOND', 'R', '2027-04-13'],
  ['10-Year', 'NOTE', '', '2026-11-10'], ['30-Year', 'BOND', '', '2026-11-12'],   // already held: ignored
];
const xmlA = rows => `<?xml version="1.0"?><AuctionSchedule><Title>Nov26_Refunding_Auction_Calendar_Official_v2</Title>${rows.map(([term, type, r, d]) =>
  `<Auction><SecurityTerm>${term}</SecurityTerm><SecurityType>${type}</SecurityType><Reopening>${r}</Reopening><AnnouncementDate>${d.slice(0, 8)}01</AnnouncementDate><AuctionDate>${d}</AuctionDate><SettlementDate>${d.slice(0, 8)}15</SettlementDate></Auction>`).join('')}</AuctionSchedule>`;
const xmlB = rows => `<Schedule>${rows.map(([term, type, r, d]) => `<Security type="${type}" term="${term}" reopening="${r}" announcement="12/01/2026" auctionDate="${d}" settlement="${d}"/>`).join('')}</Schedule>`;
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LD = d => { const x = new Date(d + 'T00:00:00Z'); return `${WD[x.getUTCDay()]}, ${FULL[x.getUTCMonth()]} ${String(x.getUTCDate()).padStart(2, '0')}, ${x.getUTCFullYear()}`; };
const textC = rows => `<doc>${rows.map(([term, type, r, d]) => `${term} ${type} ${r} ${LD(d.slice(0, 8) + '01')} ${LD(d)} ${LD(d.slice(0, 8) + '15')}`).join(' ')}</doc>`;
const TD_NOTE = [{ cusip: '912810UR7', securityType: 'Note', securityTerm: '9-Year 10-Month', announcementDate: '2026-12-03T00:00:00', auctionDate: '2026-12-08T00:00:00' },
  { securityType: 'Note', securityTerm: '2-Year', auctionDate: '2026-11-23T00:00:00' }, { securityType: 'TIPS', securityTerm: '10-Year', auctionDate: '2026-11-19T00:00:00' }];
const TD_BOND = [{ securityType: 'Bond', securityTerm: '29-Year 10-Month', auctionDate: '2026-12-10T00:00:00' }, { securityType: 'Bond', securityTerm: '19-Year 10-Month', auctionDate: '2026-12-22T00:00:00' }];
const tdGet = (xml, extra = {}) => fakeGet({ 'announced?format=json&type=Note': TD_NOTE, 'announced?format=json&type=Bond': TD_BOND, 'TentativeAuctionScheduleQ42026.xml': xml, ...extra });

const rec = (srcs, changes = []) => ({ v: 1, at: NOW, src: srcs, changes });
const eff = (r, today = TODAY) => mergeSchedule(SCHED, r, IND, today);
const line = (m, k, p) => m.releases.find(r => r.k === k && (p ? r.p === p : true));

// ================= BLS =================
test('BLS page: rows come out as reference month, release date and 24 h time, whatever the table markup', () => {
  const rows = parseBls(blsPage([{ p: 'Oct', d: '2026-11-10', t: '08:30' }, { p: 'Dec', d: '2027-01-13', t: '08:30' }, { p: 'Sep', d: '2026-11-03', t: '10:00' }]));
  assert.deepEqual(rows, [{ p: 'Oct', d: '2026-11-10', t: '08:30' }, { p: 'Dec', d: '2027-01-13', t: '08:30' }, { p: 'Sep', d: '2026-11-03', t: '10:00' }]);
  assert.equal(parseBls('<html>nothing here</html>').length, 0);
  assert.equal(parseBls('<td>October 2026</td><td>Nov. 10, 2026</td><td>1:30 PM</td>')[0].t, '13:30');
});

test('release identity: a date that moves is still the same release; weekly releases are keyed by week', () => {
  assert.equal(refYM('Dec', '2027-01-13'), '2026-12'); assert.equal(refYM('Oct', '2026-11-10'), '2026-10');
  assert.equal(lineKey({ k: 'cpi', p: 'Nov', d: '2026-12-10' }, IND), lineKey({ k: 'cpi', p: 'Nov', d: '2026-12-11' }, IND));
  assert.equal(lineKey({ k: 'claims', d: '2026-11-25' }, IND), lineKey({ k: 'claims', d: '2026-11-26' }, IND));   // Wednesday and Thursday of Thanksgiving week
  assert.notEqual(lineKey({ k: 'claims', d: '2026-11-19' }, IND), lineKey({ k: 'claims', d: '2026-11-25' }, IND));
  assert.equal(lineKey({ k: 'auc10', d: '2026-12-08' }, IND), lineKey({ k: 'auc10', d: '2026-12-09' }, IND));
});

test('BLS sync of an unchanged schedule changes nothing and only adds the 2027 months the file did not have', async () => {
  const b = await runBls({ get: blsGet(), IND, now: NOW, prev: null });
  assert.ok(b.ok); assert.equal(b.err, null);
  assert.deepEqual(Object.keys(b.k).sort(), ['cpi', 'jolts', 'nfp', 'ppi']);
  const before = eff(null), after = eff(rec({ bls: b }));
  assert.deepEqual(diffSchedules(before, after, IND, TODAY).filter(c => c.type !== 'added'), []);
  assert.ok(after.stats.added >= 5, 'PPI 2027 is new');
  assert.equal(after.checked.cpi, TODAY); assert.equal(after.checked.ppi, TODAY);
  assert.ok(after.releases.some(r => r.k === 'ppi' && r.d === '2027-03-12' && r.p === 'Feb'));
});

test('BLS moves a date: the schedule follows, the old date is replaced (not doubled), a note and a changelog entry appear, the audit stays clean', async () => {
  const pages = PAGES();
  pages.cpi = blsPage(fromBase('cpi').map(r => (r.d === '2026-12-10' ? { ...r, d: '2026-12-11' } : r)));
  const b = await runBls({ get: blsGet(pages), IND, now: NOW, prev: null });
  const m = eff(rec({ bls: b }));
  const cpis = m.releases.filter(r => r.k === 'cpi' && r.p === 'Nov' && r.d.startsWith('2026-12'));
  assert.equal(cpis.length, 1); assert.equal(cpis[0].d, '2026-12-11');
  assert.match(cpis[0].n, /Date changed from 2026-12-10/);
  const ch = diffSchedules(eff(null), m, IND, TODAY).find(c => c.type === 'moved');
  assert.deepEqual([ch.k, ch.from.d, ch.to.d], ['cpi', '2026-12-10', '2026-12-11']);
  const iss = syncIssues(rec({ bls: b }, [{ ...ch, at: NOW, src: 'bls' }]), NOW + 3600e3, IND, false);
  assert.ok(iss.some(i => i.code === 'sync_moved' && /CPI \(Nov\) moved from 2026-12-10/.test(i.msg)));
  const a = audit({ ...SCHED, releases: m.releases, checked: m.checked }, IND, NOW);
  assert.deepEqual(a.issues.filter(i => i.lvl === 'error'), []);
  const ev = expand({ ...SCHED, releases: m.releases }, IND).filter(e => e.k === 'cpi' && e.pd === 'Nov' && e.d < '2027');
  assert.equal(ev.length, 3); assert.ok(ev.every(e => e.d === '2026-12-11'));
});

test('a date the page lists on a weekend or holiday is refused, the file keeps its date, and the schedule check says why', async () => {
  const pages = PAGES();
  pages.cpi = blsPage(fromBase('cpi').map(r => (r.d === '2026-12-10' ? { ...r, d: '2026-12-12' } : r)));   // a Saturday
  const b = await runBls({ get: blsGet(pages), IND, now: NOW, prev: null });
  assert.equal(b.k.cpi.rejected.length, 1);
  const m = eff(rec({ bls: b }));
  assert.equal(line(m, 'cpi', 'Nov').d, '2026-12-10');
  assert.ok(m.issues.some(i => i.code === 'sync_rejected' && /a weekend/.test(i.msg)));
  assert.equal(checkLine({ k: 'cpi', d: '2026-11-26', t: '08:30' }, IND), 'a federal holiday (Thanksgiving)');
  assert.match(checkLine({ k: 'cpi', d: '2026-12-10', t: '09:00' }, IND), /not a usual cpi time/);
});

test('a release that disappears from a complete BLS page is dropped; a short or broken page never prunes', async () => {
  const pages = PAGES();
  pages.cpi = blsPage(fromBase('cpi').filter(r => r.d !== '2027-03-10'));
  const m = eff(rec({ bls: await runBls({ get: blsGet(pages), IND, now: NOW, prev: null }) }));
  assert.ok(!m.releases.some(r => r.k === 'cpi' && r.d === '2027-03-10'));
  assert.equal(m.stats.removed, 1);
  const short = PAGES(); short.cpi = blsPage(fromBase('cpi').slice(0, 4));
  const m2 = eff(rec({ bls: await runBls({ get: blsGet(short), IND, now: NOW, prev: null }) }));
  assert.ok(m2.releases.some(r => r.k === 'cpi' && r.d === '2027-03-10'));
  assert.equal(m2.stats.removed, 0);
});

test('BLS failure keeps the last good dates, says so, and one page failing does not stop the others', async () => {
  const first = await runBls({ get: blsGet(), IND, now: NOW, prev: null });
  const pages = PAGES(); delete pages.cpi; pages.ppi = 'Access Denied';
  const second = await runBls({ get: blsGet(pages), IND, now: NOW + DAYMS, prev: first });
  assert.equal(second.k.cpi.ok, false); assert.ok(second.k.cpi.lines.length > 5, 'old lines kept');
  assert.equal(second.k.ppi.ok, false); assert.match(second.k.ppi.err, /no release rows/);
  assert.equal(second.k.nfp.ok, true); assert.ok(second.ok);
  assert.deepEqual(eff(rec({ bls: first })).releases.filter(r => r.k === 'cpi'), eff(rec({ bls: second })).releases.filter(r => r.k === 'cpi'));
  const iss = syncIssues(rec({ bls: second }), NOW + DAYMS, IND, false);
  assert.ok(iss.some(i => i.code === 'sync_failed' && /could not read CPI/.test(i.msg)));
  const dead = await runBls({ get: fakeGet({}), IND, now: NOW + DAYMS, prev: first });
  assert.equal(dead.ok, false);
  assert.ok(syncIssues(rec({ bls: dead }), NOW + DAYMS, IND, false).some(i => i.code === 'sync_failed'));
});
const DAYMS = 864e5;

// ================= Treasury =================
test('Treasury classification: 10-year notes and 30-year bonds in all their spellings, nothing else', () => {
  for (const t of ['Note 10-Year', '10-Year NOTE R', 'Note 9-Year 10-Month', '10-Year Note (Reopening)']) assert.equal(classifyTreasury(t), 'auc10', t);
  for (const t of ['Bond 30-Year', '30-Year BOND R', 'Bond 29-Year 11-Month']) assert.equal(classifyTreasury(t), 'auc30', t);
  for (const t of ['TIPS 10-Year', '10-Year TIPS (Reopening)', 'Note 2-Year', 'Note 3-Year', 'Bond 20-Year', 'Bond 19-Year 10-Month', 'FRN 2-Year', 'Bill 13-Week', '30-Year TIPS', 'Note 7-Year']) assert.equal(classifyTreasury(t), null, t);
});

test('dates in the formats Treasury uses', () => {
  for (const s of ['2026-12-08', '2026-12-08T00:00:00', '12/08/2026', 'Tuesday, December 08, 2026', 'December 8, 2026', '8-Dec-2026']) assert.equal(parseDateLoose(s), '2026-12-08', s);
  assert.equal(parseDateLoose('soon'), null);
});

test('TreasuryDirect announced list: only 10-year notes and 30-year bonds still to come', () => {
  assert.deepEqual(parseTreasuryJson(TD_NOTE, TODAY).map(({ k, d }) => ({ k, d })), [{ k: 'auc10', d: '2026-12-08' }]);
  assert.deepEqual(parseTreasuryJson(TD_BOND, TODAY).map(({ k, d }) => ({ k, d })), [{ k: 'auc30', d: '2026-12-10' }]);
  assert.deepEqual(parseTreasuryJson({ error: 'x' }, TODAY), []);
});

test('the tentative schedule is read from any of three plausible file layouts', () => {
  const want = [['auc10', '2026-12-08'], ['auc30', '2026-12-10'], ['auc10', '2027-01-12'], ['auc30', '2027-01-13'], ['auc10', '2027-02-10'], ['auc30', '2027-02-11'],
    ['auc10', '2027-03-10'], ['auc30', '2027-03-11'], ['auc10', '2027-04-12'], ['auc30', '2027-04-13']].sort();
  for (const [name, xml] of [['elements', xmlA(TENT)], ['attributes', xmlB(TENT)], ['text rows', textC(TENT)]]) {
    const got = parseTentative(xml, TODAY).map(r => [r.k, r.d]).sort();
    assert.deepEqual(got, want, name);
  }
  assert.deepEqual(parseTentative('<html>Access Denied</html>', TODAY), []);
});

test('refunding quarters name the right file', () => {
  assert.equal(tentUrl(refundingQuarter('2026-11-15')), 'https://home.treasury.gov/system/files/221/TentativeAuctionScheduleQ42026.xml');
  assert.deepEqual(refundingQuarter('2027-01-20'), { q: 4, y: 2026 }); assert.deepEqual(refundingQuarter('2027-02-03'), { q: 1, y: 2027 }); assert.deepEqual(refundingQuarter('2026-08-05'), { q: 3, y: 2026 });
});

// the file as it stood before the sync was built: the 10-year auction guessed on Wed 9 Dec
const OLD = { ...SCHED, releases: SCHED.releases.map(r => (r.k === 'auc10' && r.d === '2026-12-08' ? { ...r, d: '2026-12-09' } : r)) };
test('Treasury sync corrects the December 10-year date, confirms the 30-year, adds six months, and the audit stays clean', async () => {
  const t = await runTreasury({ get: tdGet(xmlA(TENT)), IND, now: NOW, prev: null });
  assert.ok(t.ok); assert.equal(t.k.auc10.parts.tentative, 'ok'); assert.deepEqual(t.k.auc10.parts.files, ['Q42026']);
  const m = mergeSchedule(OLD, rec({ treasury: t }), IND, TODAY);
  const d10 = m.releases.filter(r => r.k === 'auc10' && r.d.startsWith('2026-12')), d30 = m.releases.filter(r => r.k === 'auc30' && r.d.startsWith('2026-12'));
  assert.equal(d10.length, 1); assert.equal(d10[0].d, '2026-12-08'); assert.equal(d30.length, 1); assert.equal(d30[0].d, '2026-12-10');
  assert.equal(d10[0].v, undefined, 'the announced list made it official'); assert.ok(!/confirm/i.test(d10[0].n || ''));
  assert.equal(m.releases.filter(r => r.k === 'auc10').length, 2 + 4 + 1 - 1 + 0, 'Nov, Dec, and Jan to Apr');
  const feb = line(m, 'auc10', undefined) && m.releases.find(r => r.k === 'auc10' && r.d === '2027-02-10');
  assert.equal(feb.v, 'tent'); assert.equal(feb.t, '13:00');
  const mv = diffSchedules(mergeSchedule(OLD, null, IND, TODAY), m, IND, TODAY).filter(c => c.type === 'moved');
  assert.deepEqual(mv.map(c => [c.k, c.from.d, c.to.d]), [['auc10', '2026-12-09', '2026-12-08']]);   // the date that was wrong in the file
  assert.deepEqual(audit({ ...SCHED, releases: m.releases, checked: m.checked }, IND, NOW).issues.filter(i => i.lvl === 'error'), []);
  assert.equal(m.tiers.tent, 8);
});

test('without the announced list the tentative date stays tentative; without the file the announced list still works', async () => {
  const noAnn = await runTreasury({ get: fakeGet({ 'TentativeAuctionScheduleQ42026.xml': xmlA(TENT) }), IND, now: NOW, prev: null });
  assert.equal(noAnn.k.auc10.parts.announced, 'failed');
  const mA = mergeSchedule(OLD, rec({ treasury: noAnn }), IND, TODAY);
  assert.equal(mA.releases.find(r => r.k === 'auc10' && r.d === '2026-11-10').v, 'ref', 'november line untouched');
  assert.equal(mA.releases.find(r => r.k === 'auc10' && r.d === '2026-12-08').v, 'tent');
  const noXml = await runTreasury({ get: fakeGet({ 'announced?format=json&type=Note': TD_NOTE, 'announced?format=json&type=Bond': TD_BOND }), IND, now: NOW, prev: null });
  assert.ok(noXml.ok); assert.equal(noXml.k.auc10.parts.tentative, 'failed'); assert.equal(noXml.k.auc10.prune, null);
  assert.equal(eff(rec({ treasury: noXml })).releases.find(r => r.k === 'auc10' && r.d === '2026-12-08').d, '2026-12-08');
});

test('a file that cannot be read says so, shows a sample for debugging, and changes nothing', async () => {
  const bad = await runTreasury({ get: tdGet('<html>Access Denied</html>', { 'announced?format=json&type=Note': new Error('HTTP 403 from www.treasurydirect.gov'), 'announced?format=json&type=Bond': new Error('HTTP 403 from www.treasurydirect.gov') }), IND, now: NOW, prev: null });
  assert.equal(bad.ok, false); assert.match(bad.err, /HTTP 403/); assert.match(bad.err, /no 10-year or 30-year auctions found/); assert.match(bad.debug.tentativeSample, /Access Denied/);
  const m = eff(rec({ treasury: bad }));
  assert.deepEqual(m.releases.filter(r => r.k === 'auc10'), SCHED.releases.filter(r => r.k === 'auc10'));
});

test('a quarter whose file is not out yet falls back to the previous one', async () => {
  const early = etToMs('2026-11-02T09:00'), calls = [];
  const get = fakeGet({ 'TentativeAuctionScheduleQ32026.xml': xmlA(TENT) }, calls);
  const t = await runTreasury({ get, IND, now: early, prev: null });
  assert.ok(calls.some(u => u.includes('Q32026')) && calls.some(u => u.includes('Q42026')) && calls.some(u => u.includes('Q12027')));
  assert.deepEqual(t.k.auc10.parts.files, ['Q32026']);
});

// ================= provider look-ahead =================
const row = (et, title) => ({ t: etToMs(et), title, imp: 3 });
test('provider dates fill the derived and doubtful lines, and never the agency ones', () => {
  const feeds = [{ name: 'FMP', rows: [
    row('2026-12-17T11:00', 'Crude Oil Inventories'),                // rule line, a day later and at the usual holiday-week time
    row('2026-12-17T08:30', 'Philadelphia Fed Manufacturing Index'), // rule line, same date: confirmed
    row('2026-12-15T09:45', 'S&P Global Services PMI'),            // check line (flash), a day earlier
    row('2026-12-15T09:45', 'S&P Global Manufacturing PMI'),
    row('2026-12-02T10:00', 'ISM Manufacturing PMI (Nov)'),        // agency-sourced in the file: provider may not move it
    row('2026-12-10T10:00', 'New Home Sales (Oct)'),               // 15 days from the file: too far to trust
    row('2026-12-01T09:45', 'S&P Global Manufacturing PMI (Nov)'), // final PMI, same date as the file
    row('2026-11-10T08:30', 'CPI (MoM)'),                          // in the past and not provider-managed
    row('2027-03-01T10:00', 'ISM Manufacturing PMI'),              // beyond the 40 day horizon
  ] }];
  const p = providerLines(feeds, SCHED.releases, IND, NOW);
  assert.ok(p.lines.every(l => l.v === 'prov'));
  assert.deepEqual(p.lines.map(l => l.k).sort(), ['eia', 'ism_m', 'nhs', 'philly', 'spg_f', 'spg_m'].sort());
  const m = eff(rec({ provider: runProvider({ feeds, base: SCHED.releases, IND, now: NOW, prev: null }) }));
  const eia = m.releases.find(r => r.k === 'eia' && r.d >= '2026-12-14' && r.d <= '2026-12-18');
  assert.deepEqual([eia.d, eia.t, eia.v], ['2026-12-17', '11:00', 'prov']);
  assert.equal(m.releases.find(r => r.k === 'philly' && r.p === 'Dec').v, 'prov');
  const f = m.releases.find(r => r.k === 'spg_f' && r.p === 'Dec'); assert.deepEqual([f.d, f.t, f.v, f.pre], ['2026-12-15', '09:45', 'prov', 1]); assert.ok(!/confirm/i.test(f.n));
  assert.equal(m.releases.find(r => r.k === 'ism_m' && r.p === 'Nov').d, '2026-12-01', 'official line untouched');
  assert.equal(m.releases.find(r => r.k === 'nhs' && r.p === 'Oct').d, '2026-11-25', 'too far apart');
  assert.ok(m.issues.some(i => i.code === 'sync_rejected' && /New Home Sales/.test(i.msg)));
  assert.equal(m.releases.filter(r => r.k === 'spg_m' && r.p === 'Nov').length, 1);
  assert.deepEqual(audit({ ...SCHED, releases: m.releases, checked: m.checked }, IND, NOW).issues.filter(i => i.lvl === 'error'), []);
});

test('provider rows are read the way the Worker gets them: FMP json through normFmp, with S&P final and flash told apart', () => {
  const fmp = normFmp([
    { date: '2026-12-01 14:45:00', country: 'US', event: 'S&P Global Manufacturing PMI', impact: 'High' },   // 09:45 ET, first business day: final
    { date: '2026-12-16 14:45:00', country: 'US', event: 'S&P Global Services PMI', impact: 'High' },        // 09:45 ET, mid month: flash
    { date: '2026-12-02 13:15:00', country: 'US', event: 'ADP Employment Change', impact: 'High' },
    { date: '2026-12-16 13:30:00', country: 'US', event: 'Retail Sales MoM', impact: 'High' },
  ]);
  const p = providerLines([{ name: 'FMP', rows: fmp }], SCHED.releases, IND, NOW);
  const by = Object.fromEntries(p.lines.map(l => [l.k, l]));
  assert.deepEqual([by.spg_m.d, by.spg_m.t, by.spg_m.p], ['2026-12-01', '09:45', 'Nov']);
  assert.deepEqual([by.spg_f.d, by.spg_f.p], ['2026-12-16', 'Dec']);
  assert.deepEqual([by.adp.d, by.adp.t, by.adp.p], ['2026-12-02', '08:15', 'Nov']);
  assert.equal(by.retail.p, 'Nov');
  const m = eff(rec({ provider: runProvider({ feeds: [{ name: 'FMP', rows: fmp }], base: SCHED.releases, IND, now: NOW, prev: null }) }));
  assert.equal(m.releases.find(r => r.k === 'retail' && r.p === 'Nov').v, undefined, 'the file already has retail from the agency');
});

test('a provider time that is not a usual time is refused; with no provider data the last look-ahead stays', () => {
  const p = providerLines([{ name: 'FMP', rows: [row('2026-12-17T08:45', 'Philadelphia Fed Manufacturing Index')] }], SCHED.releases, IND, NOW);
  assert.equal(p.lines.length, 0); assert.match(p.rejected[0].why, /not a usual philly time/);
  const good = runProvider({ feeds: [{ name: 'FMP', rows: [row('2026-12-17T08:30', 'Philadelphia Fed Manufacturing Index')] }], base: SCHED.releases, IND, now: NOW, prev: null });
  const none = runProvider({ feeds: [{ name: 'Fair Economy', rows: [], err: 'HTTP 429 from nfs.faireconomy.media' }], base: SCHED.releases, IND, now: NOW + DAYMS, prev: good });
  assert.equal(none.ok, false); assert.match(none.err, /429/); assert.equal(none.k.philly.lines.length, 1);
  assert.equal(syncIssues(rec({ provider: none }), NOW + DAYMS, IND, false).filter(i => /Calendar-feed/.test(i.msg)).length, 0, 'no key: expected, not an alarm');
  assert.equal(syncIssues(rec({ provider: none }), NOW + DAYMS, IND, true).filter(i => /Calendar-feed/.test(i.msg)).length, 1);
});

// ================= merge rules =================
test('precedence: agency beats provider beats the derived lines; the input file is never mutated; merging twice gives the same answer', async () => {
  assert.ok(rank('check') < rank('rule') && rank('rule') < rank('ref') && rank('ref') === rank('prov') && rank('prov') < rank('tent') && rank('tent') < rank(undefined));
  const snap = JSON.stringify(SCHED);
  const b = await runBls({ get: blsGet(), IND, now: NOW, prev: null });
  const prov = runProvider({ feeds: [{ name: 'FMP', rows: [row('2026-12-10T08:30', 'CPI (MoM)')] }], base: SCHED.releases, IND, now: NOW, prev: null });
  const r = rec({ bls: b, provider: prov });
  const a1 = eff(r), a2 = eff(r);
  assert.deepEqual(a1.releases, a2.releases); assert.equal(JSON.stringify(SCHED), snap);
  assert.equal(prov.k.cpi, undefined, 'cpi is not provider-managed');
});

test('the status the page shows: never run, overdue, and a summary with no lines in it', async () => {
  assert.equal(syncIssues(null, NOW, IND, false)[0].code, 'sync_never');
  const b = await runBls({ get: blsGet(), IND, now: NOW, prev: null });
  assert.deepEqual(dueSources(rec({ bls: b }), NOW + 3600e3, false), ['treasury']);
  assert.deepEqual(dueSources(rec({ bls: b }), NOW + 40 * 3600e3, true).slice(2), ['bls'], 'never-run sources first, then the oldest');
  assert.deepEqual(dueSources(rec({ bls: b }), NOW + 40 * 3600e3, false).sort(), ['bls', 'treasury']);
  const failed = { ...b, ok: false, err: 'HTTP 403' };
  assert.deepEqual(dueSources(rec({ bls: failed, treasury: b, provider: b }), NOW + 5 * 3600e3, true), [], 'a failure is not retried at once');
  assert.deepEqual(dueSources(rec({ bls: failed, treasury: b, provider: b }), NOW + 7 * 3600e3, true), ['bls']);
  assert.ok(syncIssues(rec({ bls: b }), NOW + 40 * 3600e3, IND, false).some(i => i.code === 'sync_stale'));
  const s = syncSummary(rec({ bls: b }));
  assert.equal(s.sources.bls.kinds.cpi.n > 5, true); assert.ok(!JSON.stringify(s).includes('"lines"'));
});

test('the real schedule file plus a full sync passes its own audit with no errors, and the sync gives the audit nothing to complain about', async () => {
  const b = await runBls({ get: blsGet(), IND, now: NOW, prev: null }), t = await runTreasury({ get: tdGet(xmlA(TENT)), IND, now: NOW, prev: null });
  const m = eff(rec({ bls: b, treasury: t }));
  const a = audit({ ...SCHED, releases: m.releases, checked: m.checked }, IND, NOW);
  assert.deepEqual(a.issues.filter(i => i.lvl === 'error'), [], JSON.stringify(a.issues.filter(i => i.lvl === 'error')));
  assert.ok(a.counts.tent >= 6 && a.counts.official >= 70);
  const before = audit(SCHED, IND, NOW);
  assert.ok(a.issues.filter(i => i.code === 'unconfirmed').length < before.issues.filter(i => i.code === 'unconfirmed').length, 'fewer dates in doubt after the sync');
});


// ---- FRED stand-in for the BLS pages ----
const FRED_NM = { cpi: 'Consumer Price Index', ppi: 'Producer Price Index', nfp: 'Employment Situation', jolts: 'Job Openings and Labor Turnover Survey' };
const fredJson = (move = {}) => JSON.stringify({ release_dates: [
  ...Object.keys(FRED_NM).flatMap(k => baseOf(k).filter(r => r.d >= TODAY).map(r => ({ release_id: 1, release_name: FRED_NM[k], date: move[r.k + '|' + r.d] || r.d }))),
  { release_id: 9, release_name: 'Advance Monthly Sales for Retail and Food Services', date: '2026-12-16' },
  { release_id: 10, release_name: 'Consumer Price Index (data not included in press release)', date: '2026-12-10' },
] });
const fredGet = (body, status = 200) => async u => { if (status !== 200) throw new Error(`HTTP ${status} from api.stlouisfed.org`); return typeof body === 'function' ? body(u) : body; };
const KINDS = ['cpi', 'ppi', 'nfp', 'jolts'];

test('FRED: dates that agree with the file change nothing and the key stays out of the URL logs', async () => {
  const seen = [];
  const f = await runFred({ get: async u => { seen.push(u); return fredJson(); }, key: 'SECRETKEY', kinds: KINDS, IND, base: SCHED.releases, now: NOW, prev: null });
  assert.equal(f.err, null); assert.ok(KINDS.every(k => f.k[k].ok && f.k[k].n > 0 && f.k[k].via === 'fred'));
  assert.match(seen[0], /api_key=SECRETKEY/); assert.match(seen[0], /include_release_dates_with_no_data=true/);
  const m = eff(rec({ bls: { at: NOW, day: TODAY, ok: true, err: null, k: f.k } }));
  assert.deepEqual(diffSchedules(eff(null), m, IND, TODAY), []);
  assert.equal(m.stats.added, 0);
});

test('FRED moves a date by a day: the schedule follows it, with a note that names FRED', async () => {
  const f = await runFred({ get: fredGet(fredJson({ 'cpi|2026-12-10': '2026-12-11' })), key: 'k', kinds: ['cpi'], IND, base: SCHED.releases, now: NOW, prev: null });
  const m = eff(rec({ bls: { at: NOW, day: TODAY, ok: true, err: null, k: f.k } }));
  const l = line(m, 'cpi', 'Nov');
  assert.equal(l.d, '2026-12-11'); assert.equal(l.t, '08:30'); assert.match(l.n, /changed from 2026-12-10.*FRED release calendar/);
  assert.equal(m.releases.filter(r => r.k === 'cpi' && r.p === 'Nov' && r.d.startsWith('2026-12')).length, 1);   // the Nov 2027 line is a different release
});

test('FRED: a move of more than a week, a weekend date, and a missing release are reported and never applied', async () => {
  const far = await runFred({ get: fredGet(fredJson({ 'cpi|2026-12-10': '2026-12-18' })), key: 'k', kinds: ['cpi'], IND, base: SCHED.releases, now: NOW, prev: null });
  assert.equal(far.k.cpi.rejected.length, 1); assert.match(far.k.cpi.rejected[0].why, /too far apart/);
  assert.equal(line(eff(rec({ bls: { at: NOW, day: TODAY, ok: true, err: null, k: far.k } })), 'cpi', 'Nov').d, '2026-12-10');
  const wk = await runFred({ get: fredGet(fredJson({ 'cpi|2026-12-10': '2026-12-12' })), key: 'k', kinds: ['cpi'], IND, base: SCHED.releases, now: NOW, prev: null });
  assert.match(wk.k.cpi.rejected[0].why, /a weekend/);
  const none = await runFred({ get: fredGet(JSON.stringify({ release_dates: [{ release_name: 'Something else', date: '2026-12-10' }] })), key: 'k', kinds: ['cpi'], IND, base: SCHED.releases, now: NOW, prev: null });
  assert.equal(none.k.cpi.ok, false); assert.match(none.err, /no upcoming dates/);
});

test('FRED: a failed request (bad key, blocked, not JSON) fails every kind without touching the calendar and without leaking the key', async () => {
  for (const get of [fredGet('', 520), fredGet('<html>nope</html>'), async () => { throw new Error('boom api_key=SECRETKEY'); }]) {
    const f = await runFred({ get, key: 'SECRETKEY', kinds: KINDS, IND, base: SCHED.releases, now: NOW, prev: null });
    assert.ok(KINDS.every(k => f.k[k].ok === false)); assert.ok(!JSON.stringify(f).includes('SECRETKEY'));
    const m = eff(rec({ bls: { at: NOW, day: TODAY, ok: false, err: f.err, k: f.k } }));
    assert.deepEqual(diffSchedules(eff(null), m, IND, TODAY), []);
  }
  assert.equal(parseFredDates({}).length, 0);
  assert.match(FRED_URL('a b', '2026-11-15'), /api_key=a%20b/);
});


// ---- Treasury false positives: a TIPS reopening ("9-Year 11-Month") must never read as the 10-year note ----
test('Treasury: TIPS and floating-rate auctions are ignored whatever the field that says so, and two dates in one month are not applied', () => {
  const rows = [
    { securityType: 'Note', securityTerm: '10-Year', auctionDate: '2026-12-08T00:00:00' },
    { securityType: 'Note', securityTerm: '9-Year 11-Month', tips: 'Yes', auctionDate: '2026-11-19T00:00:00' },
    { securityType: 'Note', securityTerm: '9-Year 11-Month', inflationIndexSecurity: 'Yes', auctionDate: '2026-12-17T00:00:00' },
    { securityType: 'TIPS', securityTerm: '9-Year 11-Month', auctionDate: '2026-12-18T00:00:00' },
    { securityType: 'Bond', securityTerm: '30-Year', auctionDate: '2026-12-10T00:00:00' },
  ];
  const r = parseTreasuryJson(rows, '2026-11-16');
  assert.deepEqual(r.map(x => [x.k, x.d]), [['auc10', '2026-12-08'], ['auc30', '2026-12-10']]);
});

test('Treasury: a second 10-year date in the same month (an unflagged TIPS reopening) is reported and neither date is applied', async () => {
  const get = async u => (/type=Note/.test(u) ? JSON.stringify([
    { securityType: 'Note', securityTerm: '10-Year', auctionDate: '2026-12-08' }, { securityType: 'Note', securityTerm: '9-Year 11-Month', auctionDate: '2026-12-17' }]) : /type=Bond/.test(u) ? '[]' : (() => { throw new Error('HTTP 404 from home.treasury.gov'); })());
  const o = await runTreasury({ get, IND, now: NOW, prev: null });
  assert.ok(o.k.auc10.rejected.some(x => /two .* dates in one month/.test(x.why)));
  assert.ok(!o.k.auc10.lines.some(l => l.d.startsWith('2026-12')));
  assert.ok(o.debug.announced.length === 2);
});

test('a release that already happened is never moved: a later date in the same month is a different release', () => {
  const treasury = { at: NOW, day: '2026-11-16', ok: true, err: null, k: { auc10: { at: NOW, ok: true, n: 1, lines: [{ d: '2026-11-19', t: '13:00', k: 'auc10' }], seen: [], rejected: [], prune: null } } };
  const m = eff(rec({ treasury }), '2026-11-16');
  assert.equal(line(m, 'auc10', undefined) && m.releases.find(r => r.k === 'auc10' && r.d.startsWith('2026-11')).d, '2026-11-10');
  assert.equal(m.stats.updated, 0);
});

// ---- the real layout of Treasury's tentative file (read from the Q3 2026 XML): TIPS and FRN are Y/N flag elements, never words ----
const rec4 = ([term, type, reopen, tips, frn, d]) => `<AuctionCalendarDate><SecurityTermWeekYear>${term}</SecurityTermWeekYear><SecurityType>${type}</SecurityType>${reopen ? `<ReOpeningIndicator>${reopen}</ReOpeningIndicator>` : ''}<TIPS>${tips}</TIPS><FloatingRate>${frn}</FloatingRate><AnnouncementDate>${d.slice(0, 8)}01</AnnouncementDate><AuctionDate>${d}</AuctionDate><SettlementDate>${d.slice(0, 8)}28</SettlementDate></AuctionCalendarDate>`;
const REAL = [
  ['10-Year', 'NOTE', 'Y', 'Y', 'N', '2026-11-19'],   // the 10-year TIPS reopening that was read as the 10-year note
  ['3-Year', 'NOTE', 'N', 'N', 'N', '2026-12-07'], ['10-Year', 'NOTE', 'Y', 'N', 'N', '2026-12-08'], ['30-Year', 'BOND', 'Y', 'N', 'N', '2026-12-10'],
  ['2-Year', 'NOTE', 'N', 'N', 'Y', '2026-12-23'], ['13-Week', 'BILL', '', 'N', 'N', '2026-12-07'],
  ['10-Year', 'NOTE', 'Y', 'N', 'N', '2027-01-12'], ['10-Year', 'NOTE', 'Y', 'Y', 'N', '2027-01-21'], ['30-Year', 'BOND', 'Y', 'N', 'N', '2027-01-13'],
  ['10-Year', 'NOTE', 'N', 'N', 'N', '2027-02-10'], ['30-Year', 'BOND', 'N', 'N', 'N', '2027-02-11'], ['30-Year', 'BOND', 'Y', 'Y', 'N', '2027-02-18'],
  ['10-Year', 'NOTE', 'Y', 'N', 'N', '2027-03-10'], ['10-Year', 'NOTE', 'Y', 'Y', 'N', '2027-03-18'], ['30-Year', 'BOND', 'Y', 'N', 'N', '2027-03-11'],
  ['10-Year', 'NOTE', 'Y', 'N', 'N', '2027-04-12'], ['30-Year', 'BOND', 'Y', 'N', 'N', '2027-04-13'],
  ['10-Year', 'NOTE', 'N', 'N', 'N', '2026-11-10'],   // already held
];
const xmlD = rows => `<?xml version="1.0" encoding="utf-8"?><AuctionCalendar xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><AuctionCalendarName>Nov2026 Refunding Auction Calendar</AuctionCalendarName><StartDate>2026-11-04</StartDate><EndDate>2027-04-30</EndDate>`
  + `<AuctionCalendarDate><HolidayName>Veterans Day</HolidayName><HolidayDate>2026-11-11</HolidayDate></AuctionCalendarDate>${rows.map(rec4).join('')}`
  + `<AuctionCalendarDate><HolidayName>Christmas</HolidayName><HolidayDate>2026-12-25</HolidayDate></AuctionCalendarDate></AuctionCalendar>`;

test('the real tentative layout: a TIPS or FRN flag keeps a 10-year TIPS reopening from being read as the 10-year note or the 30-year bond', async () => {
  const got = parseTentative(xmlD(REAL), TODAY).map(r => [r.k, r.d]).sort();
  const want = [['auc10', '2026-12-08'], ['auc30', '2026-12-10'], ['auc10', '2027-01-12'], ['auc30', '2027-01-13'], ['auc10', '2027-02-10'], ['auc30', '2027-02-11'],
    ['auc10', '2027-03-10'], ['auc30', '2027-03-11'], ['auc10', '2027-04-12'], ['auc30', '2027-04-13']].sort();
  assert.deepEqual(got, want);
  for (const bad of ['2026-11-19', '2027-01-21', '2027-02-18', '2027-03-18']) assert.ok(!got.some(([, d]) => d === bad), bad);
  // the whole pipeline: the November 10-year stays on the 10th, and no month ends up with two dates
  const t = await runTreasury({ get: tdGet(xmlD(REAL)), IND, now: NOW, prev: null });
  const m = mergeSchedule(SCHED, rec({ treasury: t }), IND, TODAY);
  assert.ok(!m.releases.some(r => r.k === 'auc10' && r.d === '2026-11-19'));
  for (const k of ['auc10', 'auc30']) {
    const months = m.releases.filter(r => r.k === k).map(r => r.d.slice(0, 7));
    assert.equal(new Set(months).size, months.length, `${k}: one date per month`);
  }
  assert.deepEqual(audit({ ...SCHED, releases: m.releases, checked: m.checked }, IND, NOW).issues.filter(i => i.lvl === 'error'), []);
});

test('a flagged record is skipped whatever the flag element is called, and N or empty flags do not hide a real auction', () => {
  const one = (flag, v) => `<AuctionCalendar><AuctionCalendarDate><SecurityTermWeekYear>10-Year</SecurityTermWeekYear><SecurityType>NOTE</SecurityType><${flag}>${v}</${flag}><AuctionDate>2026-12-08</AuctionDate></AuctionCalendarDate>`
    + `<AuctionCalendarDate><SecurityTermWeekYear>30-Year</SecurityTermWeekYear><SecurityType>BOND</SecurityType><${flag}>${v}</${flag}><AuctionDate>2026-12-10</AuctionDate></AuctionCalendarDate>`
    + `<AuctionCalendarDate><SecurityTermWeekYear>10-Year</SecurityTermWeekYear><SecurityType>NOTE</SecurityType><${flag}>${v}</${flag}><AuctionDate>2027-01-12</AuctionDate></AuctionCalendarDate></AuctionCalendar>`;
  for (const f of ['TIPS', 'InflationIndexed', 'FloatingRate']) {
    for (const on of ['Y', 'Yes', 'true']) assert.deepEqual(parseTentative(one(f, on), TODAY), [], `${f}=${on}`);
    for (const off of ['N', 'No', 'false', '']) assert.equal(parseTentative(one(f, off), TODAY).length, 3, `${f}=${off}`);
  }
});

test('audit: JOLTS lines are counted by reference month, so end-of-month release dates are not a gap or a duplicate', () => {
  // Real BLS pattern: Feb data on 30 Mar, Mar data on 5 May (no April release), Apr data on 2 Jun; Jan data on 2 Mar, Dec data on 3 Feb.
  const J = [['2027-02-03', 'Dec'], ['2027-03-02', 'Jan'], ['2027-03-30', 'Feb'], ['2027-05-05', 'Mar'], ['2027-06-02', 'Apr']].map(([d, p]) => ({ d, t: '10:00', k: 'jolts', p, v: 'ref' }));
  const releases = SCHED.releases.filter(r => r.k !== 'jolts').concat(J);
  const cad = audit({ ...SCHED, releases }, IND, NOW).issues.filter(i => i.k === 'jolts' && (i.code === 'gap' || i.code === 'extra'));
  assert.deepEqual(cad, []);
  // a genuinely missing period is still caught
  const missing = audit({ ...SCHED, releases: releases.filter(r => !(r.k === 'jolts' && r.p === 'Feb')) }, IND, NOW).issues.filter(i => i.k === 'jolts' && i.code === 'gap');
  assert.equal(missing.length, 1); assert.match(missing[0].msg, /2027-02/);
  // and two lines for one period are still caught
  const dup = audit({ ...SCHED, releases: releases.concat([{ d: '2027-03-31', t: '10:00', k: 'jolts', p: 'Feb', v: 'ref' }]) }, IND, NOW).issues.filter(i => i.k === 'jolts' && i.code === 'extra');
  assert.equal(dup.length, 1);
});

test('a Monday 10-year or 30-year auction is not flagged as an unusual weekday', () => {
  const rel = [{ d: '2027-04-12', t: '13:00', k: 'auc10', v: 'tent' }, { d: '2027-04-13', t: '13:00', k: 'auc30', v: 'tent' }];
  const w = audit({ ...SCHED, releases: rel }, IND, NOW).issues.filter(i => i.code === 'dow');
  assert.deepEqual(w, []);
});

test('a "move" away from a date that already happened raises no warning (a TIPS auction misread as the note moving); a real future move still does', () => {
  const day = etToMs('2026-11-17T09:00');
  const past = { type: 'moved', k: 'auc10', p: null, from: { d: '2026-11-10', t: '13:00' }, to: { d: '2026-11-19', t: '13:00' }, v: 'tent', at: day - 3600e3, src: 'treasury' };
  const real = { type: 'moved', k: 'auc10', p: null, from: { d: '2026-12-10', t: '13:00' }, to: { d: '2026-12-08', t: '13:00' }, v: 'tent', at: day - 3600e3, src: 'treasury' };
  const moved = ch => syncIssues(rec({}, [ch]), day, IND, false).filter(i => i.code === 'sync_moved');
  assert.equal(moved(past).length, 0);
  assert.equal(moved(real).length, 1);
});
