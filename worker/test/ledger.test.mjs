// The actuals ledger (plan P8.30). Run: node --test test/ledger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { newLedger, fromKv, recordLedger, applyLedger, pruneLedger, rankOf, LG_KEEP } from '../src/ledger.js';

const NOW = Date.parse('2026-11-19T04:00:00Z');
const row = (over = {}) => ({ id: 'retail|2026-11-17|core', t: NOW - 2 * 864e5, k: 'retail', ...over });

test('ranks: FRED over the calendar feeds over the wire; a typed placeholder is nothing', () => {
  assert.ok(rankOf('FRED') > rankOf('Fair Economy')); assert.equal(rankOf('Fair Economy'), rankOf('FMP')); assert.ok(rankOf('FMP') > rankOf('FJ')); assert.equal(rankOf('ref'), 0); assert.equal(rankOf(undefined), 0);
});

test('an official actual is remembered; after a cold start the wire-only row gets it back with its FRED tag', () => {
  const mem = newLedger();
  assert.equal(recordLedger(mem, [row({ ac: '0.6%', sr: { ac: 'FRED' } })], NOW), true);
  const cold = [row({ ac: '0.6%', sr: { ac: 'FJ' } })];   // FRED has not answered yet: only the wire's number
  assert.equal(applyLedger(cold, mem, NOW), 1);
  assert.equal(cold[0].sr.ac, 'FRED'); assert.equal(cold[0].ac, '0.6%');
});

test('a row with no actual at all gets the remembered one', () => {
  const mem = newLedger(); recordLedger(mem, [row({ ac: '0.2%', sr: { ac: 'Fair Economy' } })], NOW);
  const e = row(); applyLedger([e], mem, NOW);
  assert.equal(e.ac, '0.2%'); assert.equal(e.sr.ac, 'Fair Economy');
});

test('a live source of the same or higher rank is never overruled; a revision of the same rank replaces the ledger copy', () => {
  const mem = newLedger(); recordLedger(mem, [row({ ac: '0.6%', sr: { ac: 'FRED' } })], NOW);
  const live = row({ ac: '0.7%', sr: { ac: 'FRED' } });   // BLS revised it
  assert.equal(applyLedger([live], mem, NOW), 0); assert.equal(live.ac, '0.7%');
  assert.equal(recordLedger(mem, [live], NOW), true); assert.equal(mem.rows[live.id].ac, '0.7%');
  const again = row({ ac: '0.7%', sr: { ac: 'FRED' } });
  assert.equal(recordLedger(mem, [again], NOW), false, 'nothing changed: nothing to write');
});

test('a lesser live source never lowers the ledger, and the wire alone is remembered only as a floor', () => {
  const mem = newLedger();
  assert.equal(recordLedger(mem, [row({ ac: '0.2%', sr: { ac: 'FJ' } })], NOW), true);
  assert.equal(mem.rows['retail|2026-11-17|core'].sa, 'FJ');
  recordLedger(mem, [row({ ac: '0.6%', sr: { ac: 'FRED' } })], NOW);
  assert.equal(mem.rows['retail|2026-11-17|core'].sa, 'FRED');
  recordLedger(mem, [row({ ac: '0.2%', sr: { ac: 'FJ' } })], NOW);
  assert.equal(mem.rows['retail|2026-11-17|core'].ac, '0.6%');
});

test('typed placeholders, rows with no source tag, future releases, holidays and old rows are never recorded', () => {
  const mem = newLedger();
  recordLedger(mem, [row({ ac: '0.9%', sr: { ac: 'ref' } }), row({ id: 'a', ac: '1', sr: {} }), row({ id: 'b', t: NOW + 3600e3, ac: '1', sr: { ac: 'FRED' } }),
    row({ id: 'c', hol: true, ac: '1', sr: { ac: 'FRED' } }), row({ id: 'd', t: NOW - 50 * 864e5, ac: '1', sr: { ac: 'FRED' } })], NOW);
  assert.deepEqual(mem.rows, {});
});

test('the revised previous (with its underline direction) comes back too, and is not recorded from other sources', () => {
  const mem = newLedger();
  recordLedger(mem, [row({ ac: '0.6%', pv: '1.1%', pvc: 'up', sr: { ac: 'FRED', pv: 'FRED' } })], NOW);
  const cold = row({ ac: '0.6%', pv: '0.9%', sr: { ac: 'FRED', pv: 'Fair Economy' } });
  assert.equal(applyLedger([cold], mem, NOW), 1);
  assert.equal(cold.pv, '1.1%'); assert.equal(cold.pvc, 'up'); assert.equal(cold.sr.pv, 'FRED');
  const mem2 = newLedger(); recordLedger(mem2, [row({ pv: '0.9%', sr: { pv: 'Fair Economy' } })], NOW);
  assert.deepEqual(mem2.rows, {});
});

test('a ledger number is not put on a release that has not happened', () => {
  const mem = newLedger(); recordLedger(mem, [row({ ac: '0.6%', sr: { ac: 'FRED' } })], NOW);
  const e = row({ t: NOW + 3600e3 }); assert.equal(applyLedger([e], mem, NOW), 0); assert.equal(e.ac, undefined);
});

test('prune and malformed KV', () => {
  const mem = newLedger(); mem.rows.old = { t: NOW - LG_KEEP - 864e5, ac: '1', sa: 'FRED' }; mem.rows.mid = { t: NOW - 70 * 864e5, ac: '1', sa: 'FRED' }; mem.rows.new = { t: NOW - 864e5, ac: '1', sa: 'FRED' };
  // rows are kept for LG_KEEP (400 days since 24 Nov; it was 60): a 70-day-old row stays, one past LG_KEEP goes
  assert.equal(LG_KEEP, 400 * 864e5);
  assert.equal(pruneLedger(mem, NOW), true); assert.deepEqual(Object.keys(mem.rows), ['mid', 'new']);
  assert.deepEqual(fromKv(null), newLedger()); assert.deepEqual(fromKv({ v: 2 }), newLedger()); assert.equal(fromKv(mem), mem);
});
