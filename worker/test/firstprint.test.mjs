// First prints (plan P8.23). Run: node --test test/firstprint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand, etToMs } from '../src/schedule.js';
import { parseFredCsv, applyOfficial } from '../src/official.js';
import { newFirst, fromKv, recordPrev, recordActual, prune, lookups, FP_KEEP } from '../src/firstprint.js';

const J = f => JSON.parse(readFileSync(new URL('../config/' + f, import.meta.url)));
const SCHED = J('schedule.json'), IND = J('indicators.json');
const fresh = () => expand(SCHED, IND).map(e => ({ ...e }));
const get = (ev, id) => ev.find(e => e.id === id);
const csv = (id, rows) => `observation_date,${id}\n` + rows.map(r => r.join(',')).join('\n');
const CORE = 'retail|2026-11-17|core', MAIN = 'retail|2026-11-17|main';
const NOW = etToMs('2026-11-18T10:00');                 // the morning after the 17 Nov print
// retail ex autos: Aug 100.0, Sep 101.1 (+1.1% after revision), Oct 101.7 (+0.6%)
const M = { RSFSXMV: parseFredCsv(csv('R', [['2026-08-01', 100.0], ['2026-09-01', 101.1], ['2026-10-01', 101.7]])) };

test('recordPrev remembers the previous a release showed, once, never a typed placeholder, never outside the window', () => {
  const ev = fresh(), mem = newFirst();
  get(ev, CORE).pv = '0.9%'; get(ev, CORE).sr = { pv: 'Fair Economy' };
  get(ev, MAIN).pv = '0.8%'; get(ev, MAIN).sr = { pv: 'ref' };
  assert.equal(recordPrev(mem, ev, NOW), true);
  assert.equal(mem.rows[CORE].pv0, '0.9%');
  assert.equal(mem.rows[MAIN], undefined, 'a typed placeholder is not a real source');
  get(ev, CORE).pv = '1.1%';                                           // the feed later catches up with the revision
  assert.equal(recordPrev(mem, ev, NOW), false);
  assert.equal(mem.rows[CORE].pv0, '0.9%', 'the first number stays');
  const old = fresh(); get(old, 'cpi|2026-11-10|mom').pv = '0.6%';
  assert.equal(recordPrev(newFirst(), old, NOW), false, '8 days after the release is a revision, not a first print');
});

test('recordActual keeps the first real actual of the first 3 days', () => {
  const ev = fresh(), mem = newFirst();
  get(ev, CORE).ac = '0.6%'; get(ev, CORE).sr = { ac: 'FRED' };
  get(ev, MAIN).ac = '0.2%'; get(ev, MAIN).sr = { ac: 'ref' };
  get(ev, 'cpi|2026-11-10|mom').ac = '0.4%'; get(ev, 'cpi|2026-11-10|mom').sr = { ac: 'FRED' };
  recordActual(mem, ev, NOW);
  assert.equal(mem.rows[CORE].ac0, '0.6%');
  assert.equal(mem.rows[MAIN], undefined); assert.equal(mem.rows['cpi|2026-11-10|mom'], undefined);
  get(ev, CORE).ac = '0.7%'; recordActual(mem, ev, NOW);
  assert.equal(mem.rows[CORE].ac0, '0.6%');
});

test('the 17 Nov Core retail case: the feed still says 0.9%, the official series says 1.1%: it replaces the feed and is underlined green', () => {
  const ev = fresh(), mem = newFirst(), c = get(ev, CORE);
  c.pv = '0.9%'; c.sr = { pv: 'Fair Economy' }; c.fc = '0.4%';
  recordPrev(mem, ev, NOW);
  const r = applyOfficial(ev, M, NOW, lookups(mem));
  assert.equal(c.ac, '0.6%'); assert.equal(c.sr.ac, 'FRED');
  assert.equal(c.pv, '1.1%'); assert.equal(c.sr.pv, 'FRED'); assert.equal(c.pvc, 'g');
  assert.equal(r.issues.length, 0);
});

test('no revision: the official previous equals the remembered one, so nothing is underlined; the shown text is kept', () => {
  const ev = fresh(), mem = newFirst(), c = get(ev, CORE);
  c.pv = '1.10%'; c.sr = { pv: 'Fair Economy' };
  recordPrev(mem, ev, NOW);
  applyOfficial(ev, M, NOW, lookups(mem));
  assert.equal(c.pv, '1.10%'); assert.equal(c.pvc, undefined); assert.equal(c.sr.pv, 'FRED');
});

test('without a remembered previous the earlier release in the list is used, and its first actual beats its later value', () => {
  const ev = fresh();
  const claimsM = { ICSA: parseFredCsv(csv('ICSA', [['2026-10-31', 195000], ['2026-11-07', 200000]])) };
  const after = etToMs('2026-11-14T12:00');
  const mem = newFirst(); mem.rows['claims|2026-11-05|main'] = { t: 0, ac0: '189K' };
  get(ev, 'claims|2026-11-05|main').ac = '191K'; get(ev, 'claims|2026-11-05|main').sr = { ac: 'ref' };   // a later, typed number
  applyOfficial(ev, claimsM, after, lookups(mem));
  const c = get(ev, 'claims|2026-11-12|main');
  assert.equal(c.pv, '195K'); assert.equal(c.pvc, 'r', 'claims up is bad news: red');
});

test('a row the official series does not cover is left alone, and the memory prunes old rows and survives a bad KV value', () => {
  const ev = fresh(), mem = newFirst(), n = get(ev, 'eia|2026-11-18|main');
  n.pv = '4.657M'; n.sr = { pv: 'ref' };
  applyOfficial(ev, M, NOW, lookups(mem));
  assert.equal(n.pv, '4.657M'); assert.equal(n.sr.pv, 'ref');
  mem.rows.a = { t: NOW - FP_KEEP - 1, pv0: '1' }; mem.rows.b = { t: NOW, pv0: '2' };
  assert.equal(prune(mem, NOW), true); assert.deepEqual(Object.keys(mem.rows), ['b']);
  assert.deepEqual(fromKv({ nonsense: 1 }), newFirst()); assert.deepEqual(fromKv(null), newFirst());
});
