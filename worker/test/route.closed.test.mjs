// Closed-market back-off: a cash-market quote frozen at the close is reused for 5 minutes instead of 30 seconds, except around the open.
// Run: node --test test/route.closed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { closedTtl, backoffTtl, CLOSED_TTL } from '../src/route.js';
import { makeSectors } from '../src/sectors.js';

const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi);
const B = 30000;

test('closedTtl: winter (EST), the cases that matter', () => {
  const close = utc(2026, 11, 16, 21, 0);                                   // Mon 16:00 ET close
  assert.equal(closedTtl(close, utc(2026, 11, 17, 7, 35), B), CLOSED_TTL);  // Tue 02:35 ET, frozen
  assert.equal(closedTtl(close, utc(2026, 11, 16, 21, 20), B), B);          // 20 min after the close: the quote is not 30 min old yet
  assert.equal(closedTtl(close, utc(2026, 11, 16, 21, 31), B), CLOSED_TTL); // 16:31 ET: past 16:30 and older than 30 min
  assert.equal(closedTtl(utc(2026, 11, 16, 20, 0), utc(2026, 11, 16, 21, 25), B), B);   // 16:25 ET (guard window ends 16:30): no back-off
  assert.equal(closedTtl(close, utc(2026, 11, 17, 13, 59), B), CLOSED_TTL); // Tue 08:59 ET
  assert.equal(closedTtl(close, utc(2026, 11, 17, 14, 0), B), B);           // Tue 09:00 ET: normal again
  assert.equal(closedTtl(close, utc(2026, 11, 17, 15, 30), B), B);          // the open, quote still frozen: normal
  assert.equal(closedTtl(close, utc(2026, 11, 17, 21, 29), B), B);          // 16:29 ET still in the guard window
});
test('closedTtl: weekend and Friday close', () => {
  const fri = utc(2026, 11, 13, 21, 0);
  assert.equal(closedTtl(fri, utc(2026, 11, 14, 17, 0), B), CLOSED_TTL);    // Saturday noon
  assert.equal(closedTtl(fri, utc(2026, 11, 15, 17, 0), B), CLOSED_TTL);    // Sunday noon
  assert.equal(closedTtl(fri, utc(2026, 11, 16, 13, 59), B), CLOSED_TTL);   // Monday 08:59 ET
  assert.equal(closedTtl(fri, utc(2026, 11, 16, 14, 0), B), B);             // Monday 09:00 ET
});
test('closedTtl: summer (EDT) follows the New York clock', () => {
  const close = utc(2027, 7, 13, 20, 0);                                    // 16:00 EDT
  assert.equal(closedTtl(close, utc(2027, 7, 14, 8, 0), B), CLOSED_TTL);    // 04:00 EDT
  assert.equal(closedTtl(close, utc(2027, 7, 14, 12, 59), B), CLOSED_TTL);  // 08:59 EDT
  assert.equal(closedTtl(close, utc(2027, 7, 14, 13, 0), B), B);            // 09:00 EDT
});
test('closedTtl: a fresh quote, a missing time, and a larger base are never shortened or slowed wrongly', () => {
  assert.equal(closedTtl(utc(2026, 11, 17, 7, 20), utc(2026, 11, 17, 7, 35), B), B);   // DXY-style: traded 15 min ago, at night
  assert.equal(closedTtl(null, utc(2026, 11, 17, 7, 35), B), B);
  assert.equal(closedTtl(utc(2026, 11, 16, 21, 0), utc(2026, 11, 17, 7, 35), 15 * 60000), 15 * 60000);
});

// the whole route: 3 ETFs, one poll a minute, counting Yahoo calls
function run(startMs, quoteSec, polls) {
  return (async () => {
    let clock = startMs, calls = 0; const realNow = Date.now, realFetch = globalThis.fetch;
    Date.now = () => clock;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 99, regularMarketTime: quoteSec } }] } }), { status: 200 }); };
    const items = ['XLK', 'XLF', 'XLE'].map(l => ({ label: l, name: l, kind: 'etf', set: 'sectors', chain: [['yahoo', l]] }));
    const s = makeSectors(items), pend = [], ctx = { waitUntil: p => pend.push(p) };
    const bodies = [];
    try {
      for (let i = 0; i < polls; i++) { bodies.push(JSON.parse(await s.get({}, ctx, {}))); await Promise.all(pend.splice(0)); clock += 60000; }
    } finally { Date.now = realNow; globalThis.fetch = realFetch; }
    return { calls, bodies };
  })();
}
test('sectors at night, quotes frozen at the close: 1 fetch round in 10 minutes instead of 10', async () => {
  const start = utc(2026, 11, 17, 7, 35), frozen = utc(2026, 11, 16, 21, 0) / 1000;
  const { calls, bodies } = await run(start, frozen, 10);
  assert.ok(calls <= 6, `expected at most 2 rounds of 3, got ${calls} calls`);          // t=0, then again at +5 min (and maybe +10)
  assert.ok(bodies.every(b => b.items.every(i => i.p === 100 && !i.stale)), 'every item shown, none marked stale');
});
test('sectors in cash hours: every poll fetches, as before', async () => {
  const start = utc(2026, 11, 17, 15, 0), frozenish = utc(2026, 11, 17, 14, 59) / 1000;   // 10:00 ET
  const { calls } = await run(start, frozenish, 10);
  assert.equal(calls, 30);
});
test('sectors on a weekend: back-off applies', async () => {
  const { calls } = await run(utc(2026, 11, 14, 17, 0), utc(2026, 11, 13, 21, 0) / 1000, 10);
  assert.ok(calls <= 6, `got ${calls}`);
});

test('backoffTtl: FX, DXY and futures never back off, cash-market items do', () => {
  const fri = utc(2026, 11, 13, 21, 55), sunEve = utc(2026, 11, 15, 22, 0);   // last quote Friday 16:55 ET; now Sunday 17:00 ET, FX is about to reopen
  assert.equal(backoffTtl({ kind: 'fx', label: 'USDJPY' }, fri, sunEve, B), B);
  assert.equal(backoffTtl({ kind: 'idx', label: 'DXY' }, fri, sunEve, B), B);
  assert.equal(backoffTtl({ kind: 'fut', label: 'ES1!' }, fri, sunEve, B), B);
  assert.equal(backoffTtl({ kind: 'etf', label: 'TLT' }, utc(2026, 11, 13, 21, 0), sunEve, B), CLOSED_TTL);
  assert.equal(backoffTtl({ kind: 'idx', label: 'VIX' }, utc(2026, 11, 13, 21, 15), sunEve, B), CLOSED_TTL);
  assert.equal(backoffTtl({ kind: 'yield', label: 'USD10Y' }, utc(2026, 11, 13, 20, 0), sunEve, B), CLOSED_TTL);
});
