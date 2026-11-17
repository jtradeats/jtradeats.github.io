// P8.15: New York time by date arithmetic must equal the Intl version on every input, including the DST gap and overlap hours.
// Run: node --test test/schedule.tz.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { etParts, etPartsIntl, etToMs, audit } from '../src/schedule.js';

const NYF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
// the previous etToMs, verbatim in behaviour: two passes with the Intl offset
function etToMsIntl(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(String(s || ''));
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const off = t => { const q = etPartsIntl(t); return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - t; };
  let t = asUTC - off(asUTC); t = asUTC - off(t); return t;
}
const pad = n => String(n).padStart(2, '0');
const wall = (ms, sec) => { const x = new Date(ms); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}${sec ? ':' + pad(x.getUTCSeconds()) : ''}`; };
const edges = [];   // the DST changes 2025..2030, found with the Intl oracle
{ let prev = null; for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2031, 0, 1); t += 36e5) { const o = etPartsIntl(t), off = Date.UTC(o.y, o.mo - 1, o.d, o.h, o.mi, o.s) - t; if (prev !== null && off !== prev) edges.push(t); prev = off; } }

test('twelve DST changes found in 2025 to 2030', () => assert.equal(edges.length, 12));
test('etParts equals the Intl version every 15 minutes, 2025 to 2030', () => {
  for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2031, 0, 1); t += 15 * 60000) assert.deepEqual(etParts(t), etPartsIntl(t), new Date(t).toISOString());
});
test('etParts equals the Intl version every minute, 6 h either side of each DST change', () => {
  for (const e of edges) for (let t = e - 6 * 36e5; t <= e + 6 * 36e5; t += 60000) assert.deepEqual(etParts(t), etPartsIntl(t), new Date(t).toISOString());
});
test('etToMs equals the Intl two-pass version every 30 minutes, 2025 to 2030', () => {
  for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2031, 0, 1); t += 30 * 60000) assert.equal(etToMs(wall(t)), etToMsIntl(wall(t)), wall(t));
});
test('etToMs equals the Intl version every minute around each DST change (gap and overlap hours), with and without seconds', () => {
  for (const e of edges) { const w = e - 5 * 36e5; for (let t = w - 6 * 36e5; t <= w + 6 * 36e5; t += 60000) for (const s of [wall(t), wall(t, true), wall(t).replace('T', ' ')]) assert.equal(etToMs(s), etToMsIntl(s), s); }
});
test('the audit self-test values', () => {
  assert.equal(etToMs('2027-01-08T08:30'), Date.UTC(2027, 0, 8, 13, 30));
  assert.equal(etToMs('2027-07-02T08:30'), Date.UTC(2027, 6, 2, 12, 30));
  assert.equal(etToMs('2026-12-09T14:00'), Date.UTC(2026, 11, 9, 19, 0));
  assert.equal(etToMs('2027-03-17T14:00'), Date.UTC(2027, 2, 17, 18, 0));
});
test('bad input is null', () => { assert.equal(etToMs('nope'), null); assert.equal(etToMs(null), null); assert.equal(etToMs(undefined), null); });
test('the audit still reports no time-zone error', () => {
  const a = audit({ releases: [] }, { kinds: {} }, Date.UTC(2026, 10, 17, 15));
  assert.ok(!a.issues.some(i => i.code === 'tz'));
});
