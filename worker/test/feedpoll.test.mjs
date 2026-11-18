// Forex Factory refresh plan (P8.24). Run: node --test test/feedpoll.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expand, etToMs } from '../src/schedule.js';
import { ffHot, ffTtl, ffRetry, ffStale, mergeFeed, FF_FAST, FF_SLOW, FF_RETRY, FF_RETRY_429 } from '../src/feedpoll.js';

const J = f => JSON.parse(readFileSync(new URL('../config/' + f, import.meta.url)));
const EV = expand(J('schedule.json'), J('indicators.json'));
const RETAIL = etToMs('2026-11-17T08:30');

test('the release window opens 10 minutes before a scheduled release and closes 45 minutes after it', () => {
  assert.equal(ffHot(EV, RETAIL - 11 * 60000), false);
  assert.equal(ffHot(EV, RETAIL - 9 * 60000), true);
  assert.equal(ffHot(EV, RETAIL + 44 * 60000), true);
  assert.equal(ffHot(EV, RETAIL + 46 * 60000), false);
  assert.equal(ffHot(EV, etToMs('2026-11-17T20:00')), false, 'quiet evening');
  assert.equal(ffHot([], RETAIL), false); assert.equal(ffHot(null, RETAIL), false);
});

test('polling times: 5 minutes in a window, 30 outside; a 429 waits 15 minutes only in quiet hours', () => {
  assert.equal(ffTtl(true), FF_FAST); assert.equal(ffTtl(false), FF_SLOW);
  assert.equal(ffRetry(true, true), FF_RETRY); assert.equal(ffRetry(true, false), FF_RETRY_429);
  assert.equal(ffRetry(false, false), FF_RETRY); assert.equal(ffRetry(false, true), FF_RETRY);
  assert.equal(ffStale(14 * 60000, true), false); assert.equal(ffStale(16 * 60000, true), true);
  assert.equal(ffStale(59 * 60000, false), false); assert.equal(ffStale(91 * 60000, false), true);
});

test("a fast poll keeps next week's events from the last full poll and replaces this week's", () => {
  const D = 864e5, mon = etToMs('2026-11-16T08:30');
  const prev = [{ t: mon, title: 'old', fc: '1' }, { t: mon + 3 * D, title: 'thu old', fc: '2' }, { t: mon + 8 * D, title: 'next week', fc: '9' }];
  const fresh = [{ t: mon, title: 'old', fc: '1.5' }, { t: mon + 4 * D, title: 'fri new', fc: '3' }];
  const m = mergeFeed(prev, fresh);
  assert.deepEqual(m.map(e => e.title), ['old', 'fri new', 'next week']);
  assert.equal(m[0].fc, '1.5');                                // this week's numbers are the new ones
  assert.deepEqual(mergeFeed(null, fresh), fresh); assert.deepEqual(mergeFeed(prev, []), prev);
});

// ---- end to end: which Forex Factory files does /calendar ask for, and when ----
const tmp = mkdtempSync(join(tmpdir(), 'worker-ff-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));
const FFROW = (title, fc, pv) => ({ title, country: 'USD', date: '2026-11-17T08:30:00-05:00', impact: 'High', forecast: fc, previous: pv });
async function run(iso, tag) {
  const calls = [], realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => Date.parse(iso);
  globalThis.fetch = async u => {
    u = String(u.url || u); calls.push(u);
    if (u.includes('ff_calendar_thisweek')) return new Response(JSON.stringify([FFROW('Retail Sales m/m', '0.1%', '0.8%')]), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  try {
    const { default: worker } = await import(pathToFileURL(ix).href + '?' + tag);
    const r = await worker.fetch(new Request('https://x.workers.dev/calendar'), {}, { waitUntil() {}, passThroughOnException() {} });
    const j = await r.json();
    return { calls: calls.filter(u => u.includes('faireconomy')), j };
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}

test('inside a release window /calendar asks for this week\'s Forex Factory file only', async () => {
  const { calls, j } = await run('2026-11-17T13:25:00Z', 'hot');   // 08:25 ET, five minutes before retail sales
  assert.deepEqual(calls.map(u => u.split('/').pop()), ['ff_calendar_thisweek.json']);
  assert.match(j.feed.mode, /release window/);
});

test('in quiet hours it asks for both files', async () => {
  const { calls, j } = await run('2026-11-17T20:00:00Z', 'quiet');   // 15:00 ET, nothing scheduled
  assert.deepEqual(calls.map(u => u.split('/').pop()).sort(), ['ff_calendar_nextweek.json', 'ff_calendar_thisweek.json']);
  assert.match(j.feed.mode, /normal/);
});
