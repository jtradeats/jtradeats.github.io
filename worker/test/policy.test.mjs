// P8.9: policy facts from FRED's target-range series, the template backdrop, the decision-day rule, the stance flag, the vote parser. Run: node --test test/policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeFacts, policyBackdrop, policyIssues, decisionList, parseVotes, voteText, stanceOf, statementUrl } from '../src/policy.js';
import { etToMs } from '../src/schedule.js';

const CFG = JSON.parse(readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'));
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// a daily series from `from` to `to`: steps = [[effective date, upper]] (lower = upper - 0.25)
function series(from, to, steps) {
  const U = new Map(), L = new Map(); let u = steps[0][1];
  for (let d = from; d <= to; d = addDays(d, 1)) { for (const [e, v] of steps) if (e === d) u = v; U.set(d, u); L.set(d, u - 0.25); }
  return [U, L];
}
const AT = (d, hm = '12:00') => etToMs(`${d}T${hm}`);
const EV = [{ k: 'fomc', r: 'dec', d: '2026-12-09', t: AT('2026-12-09', '14:00') }, { k: 'fomc', r: 'dec', d: '2027-01-27', t: AT('2027-01-27', '14:00') }, { k: 'nfp', r: 'nfp', d: '2026-12-04', t: AT('2026-12-04', '08:30') }];
const DECS = decisionList(CFG, EV);
const HIKE = [['2026-06-01', 3.75], ['2026-09-17', 4.00]];   // 3.50 to 3.75, then +25 bp to 3.75-4.00 effective the day after the 16 Sep decision

test('decisionList joins the held meetings with the schedule rows, one per date, in time order, and ignores other kinds', () => {
  assert.deepEqual(DECS.map(x => x.d), ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09', '2027-01-27']);
  assert.equal(DECS.find(x => x.d === '2026-10-28').t, AT('2026-10-28', '14:00'));
});

test('19 Nov: a hike in September and a hold in October read from the series, in the old text\'s words', () => {
  const [U, L] = series('2026-06-01', '2026-11-18', HIKE), now = AT('2026-11-19'), f = computeFacts(U, L, DECS, now, '2026-11-19');
  assert.deepEqual([f.upper, f.lower, f.change.bp, f.change.eff, f.change.decision, f.change.range], [4, 3.75, 25, '2026-09-17', '2026-09-16', '3.75-4.00%']);
  assert.deepEqual(f.decision, { d: '2026-10-28', result: 'hold', reflected: true }); assert.deepEqual(f.holds, ['2026-10-28']); assert.equal(f.next, '2026-12-09');
  const b = policyBackdrop(f, DECS, now, '2026-11-19', null);
  assert.equal(b.text, 'The Fed raised the target range by 25 bp in September to 3.75-4.00% and held in October. Next decision: Wed 9 Dec.');
  assert.equal(b.asof, '2026-10-28'); assert.equal(b.checked, '2026-11-19'); assert.equal(b.pending, null);
  assert.equal(stanceOf(f), 'last move: hike (Sep 2026); hold (Oct 2026)');
});

test('with the vote read from the Fed statement the dissent sentence is added', () => {
  const [U, L] = series('2026-06-01', '2026-11-18', HIKE), now = AT('2026-11-19'), f = computeFacts(U, L, DECS, now, '2026-11-19');
  const v = parseVotes('<p>Voting for the monetary policy action were A, Chair.</p><p>Voting against this action were Lisa D. Cook and Beth M. Hammack, who preferred to raise the target range by 1/4 percentage point.</p>');
  assert.deepEqual(v, { n: 2, dirs: { hike: 2 } });
  const b = policyBackdrop(f, DECS, now, '2026-11-19', v);
  assert.match(b.text, /held in October\. 2 dissents at the latest meeting \(2 preferred a hike\)\. Next decision/); assert.match(b.src, /vote from the Fed statement/);
});

test('decision day (R62): after 14:00 ET on 9 Dec with the series not yet updated, the old range is never shown as current', () => {
  const [U, L] = series('2026-06-01', '2026-12-09', HIKE), now = AT('2026-12-09', '14:05'), f = computeFacts(U, L, DECS, now, '2026-12-09');
  assert.deepEqual(f.decision, { d: '2026-12-09', result: null, reflected: false });
  const b = policyBackdrop(f, DECS, now, '2026-12-09', null);
  assert.match(b.text, /decision of 9 Dec is not yet reflected/i); assert.ok(!/3\.75|4\.00/.test(b.text)); assert.equal(b.pending, '2026-12-09');
  // before 14:00 the same data is simply the current range and the decision is still ahead
  const early = AT('2026-12-09', '13:00'), f2 = computeFacts(U, L, DECS, early, '2026-12-09');
  assert.equal(policyBackdrop(f2, DECS, early, '2026-12-09', null).pending, null); assert.equal(f2.next, '2026-12-09');
});

test('facts built before a decision still read "not yet reflected" after it, even if nobody rebuilt them', () => {
  const [U, L] = series('2026-06-01', '2026-12-08', HIKE), f = computeFacts(U, L, DECS, AT('2026-12-08'), '2026-12-08');
  const b = policyBackdrop(f, DECS, AT('2026-12-09', '15:00'), '2026-12-09', null);
  assert.equal(b.pending, '2026-12-09');
});

test('a cut on 9 Dec once the series has it: the new range, no old hold, stance changes', () => {
  const [U, L] = series('2026-06-01', '2026-12-11', [...HIKE, ['2026-12-10', 3.75]]), now = AT('2026-12-11'), f = computeFacts(U, L, DECS, now, '2026-12-11');
  assert.deepEqual(f.decision, { d: '2026-12-09', result: 'cut', reflected: true });
  assert.equal(policyBackdrop(f, DECS, now, '2026-12-11', null).text, 'The Fed cut the target range by 25 bp in December to 3.50-3.75%. Next decision: Wed 27 Jan.');
  assert.equal(stanceOf(f), 'last move: cut (Dec 2026)');
});

test('a hold on 9 Dec after the October hold: two holds since the hike', () => {
  const [U, L] = series('2026-06-01', '2026-12-11', HIKE), now = AT('2026-12-11'), f = computeFacts(U, L, DECS, now, '2026-12-11');
  assert.deepEqual(f.holds, ['2026-10-28', '2026-12-09']);
  assert.match(policyBackdrop(f, DECS, now, '2026-12-11', null).text, /and has held at the last 2 meetings, most recently in December\./);
});

test('stance flag: a mismatch with the reviewed stance becomes an issue; a match does not', () => {
  const reviewed = { stance: 'last move: hike (Sep 2026); hold (Oct 2026)' };
  const [U, L] = series('2026-06-01', '2026-11-18', HIKE), now = AT('2026-11-19'), f = computeFacts(U, L, DECS, now, '2026-11-19');
  assert.deepEqual(policyIssues(f, DECS, now, '2026-11-19', reviewed, true), []);
  const [U2, L2] = series('2026-06-01', '2026-12-11', [...HIKE, ['2026-12-10', 3.75]]), n2 = AT('2026-12-11'), f2 = computeFacts(U2, L2, DECS, n2, '2026-12-11');
  const iss = policyIssues(f2, DECS, n2, '2026-12-11', reviewed, true);
  assert.deepEqual(iss.map(i => i.code), ['stance_changed']); assert.match(iss[0].msg, /last move: cut \(Dec 2026\).*last move: hike/);
});

test('issues: no key, never built, job stopped for 40 hours, a decision 4 days old that the data never showed', () => {
  assert.equal(policyIssues(null, DECS, AT('2026-11-19'), '2026-11-19', null, false)[0].code, 'policy_nokey');
  assert.equal(policyIssues(null, DECS, AT('2026-11-19'), '2026-11-19', null, true)[0].code, 'policy_none');
  const [U, L] = series('2026-06-01', '2026-11-18', HIKE), f = computeFacts(U, L, DECS, AT('2026-11-19'), '2026-11-19');
  assert.equal(policyIssues(f, DECS, AT('2026-11-19') + 40 * 36e5, '2026-11-20', null, true).some(i => i.code === 'policy_stale'), true);
  const old = computeFacts(...series('2026-06-01', '2026-12-08', HIKE), DECS, AT('2026-12-08'), '2026-12-08');
  assert.equal(policyIssues(old, DECS, AT('2026-12-13'), '2026-12-13', null, true).some(i => i.code === 'policy_overdue'), true);
});

test('a change that matches no decision date inside the list is flagged, one before the list is not', () => {
  const [U, L] = series('2026-02-01', '2026-11-18', [['2026-02-01', 3.50], ['2026-05-06', 3.75]]), now = AT('2026-11-19'), f = computeFacts(U, L, DECS, now, '2026-11-19');
  assert.equal(f.change.decision, null);
  assert.equal(policyIssues(f, DECS, now, '2026-11-19', null, true).some(i => i.code === 'policy_unscheduled'), true);
  assert.match(policyBackdrop(f, DECS, now, '2026-11-19', null).text, /raised the target range by 25 bp on 6 May to 3.50-3.75%/);
  const [U2, L2] = series('2025-06-01', '2026-11-18', [['2025-06-01', 3.50], ['2025-12-11', 3.75]]), f2 = computeFacts(U2, L2, DECS, now, '2026-11-19');
  assert.equal(policyIssues(f2, DECS, now, '2026-11-19', null, true).some(i => i.code === 'policy_unscheduled'), false);
});

test('parseVotes: unanimous, one dissenter, mixed preferences, and anything it cannot read gives null', () => {
  const FOR = '<p>Voting for the monetary policy action were A, Chair; B, Vice Chair.</p>';
  assert.deepEqual(parseVotes(FOR), { n: 0, dirs: {} });
  assert.deepEqual(parseVotes(FOR + '<p>Voting against this action was Michelle W. Bowman, who preferred to lower the target range by 1/4 percentage point.</p>'), { n: 1, dirs: { cut: 1 } });
  assert.deepEqual(parseVotes(FOR + '<p>Voting against this action were Stephen I. Miran, who preferred to lower the target range for the federal funds rate by 1/2 percentage point; and Jeffrey R. Schmid, who preferred no change in the target range at this meeting.</p>'), { n: 2, dirs: { cut: 1, hold: 1 } });
  assert.equal(parseVotes('<html>not the statement</html>'), null);
  assert.equal(parseVotes(FOR + '<p>Voting against this action were A and B.</p>'), null);
  assert.equal(parseVotes(FOR + '<p>Voting against this action was A, who preferred something unclear.</p>'), null);
  assert.equal(parseVotes(''), null);
});

test('voteText and statementUrl', () => {
  assert.equal(voteText({ n: 2, dirs: { cut: 1, hold: 1 } }), '2 dissents at the latest meeting (1 preferred a cut, 1 preferred no change).');
  assert.equal(voteText({ n: 1, dirs: { hike: 1 } }), '1 dissent at the latest meeting (1 preferred a hike).');
  assert.equal(voteText({ n: 0, dirs: {} }), 'No dissents at the latest meeting.');
  assert.equal(statementUrl('2026-10-28'), 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm');
});

test('a series too short to read gives no facts', () => {
  assert.equal(computeFacts(new Map([['2026-11-01', 4]]), new Map([['2026-11-01', 3.75]]), DECS, AT('2026-11-19'), '2026-11-19'), null);
});
