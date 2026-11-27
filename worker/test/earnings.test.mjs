// Tests for earnings.js (run: node --test earnings.test.mjs). The row markup is the real row Finviz sent on 27 Nov (TRX, AMC) plus variants built the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEarnings, capNum, validDay, todayEt, getEarnings } from './earnings.js';

const TD = (inner, cls = '') => `<td class="!py-1  px-1 leading-tight ${cls}">${inner}</td>`;
const LNK = v => `<a href="/stock?t=X&amp;ty=ea&amp;scroll#earnings-eps">${v}</a>`;
const DASH = LNK('<span class="text-gray-400">—</span>');
function row({ s, name, t, cap, est = '$0.02', act = DASH, sur = DASH, rev = '$33.54M', chg = '<span class="text-gray-400">—</span>' }) {
  return `<tr class="styled-row is-bordered is-hover-borders is-rounded group is-hoverable is-rounded">`
    + TD(`<span class="flex w-full items-center gap-1"><span class="company-ticker" style="--logo-url:url(&quot;https://logo.finviz.com/${s}.svg&quot;)"><img src="https://logo.finviz.com/${s}.svg" alt="${s} logo"/><span>${s[0]}</span></span><a href="/stock?t=${s}" class="group/button"><span class="grow text-left">${s}</span></a></span>`)
    + TD(`<div class="block max-w-full overflow-hidden">${name}</div>`, 'max-w-40')
    + TD(t) + TD(cap, 'text-right') + TD(est === DASH ? DASH : LNK(est), 'text-right') + TD(act, 'text-right') + TD(sur, 'text-right')
    + TD(DASH, 'hidden xl:table-cell text-right') + TD(DASH, 'text-right') + TD(DASH, 'hidden xl:table-cell text-right')
    + TD(LNK(rev), 'text-right') + TD(DASH, 'text-right') + TD(DASH, 'text-right') + TD(chg, 'text-right') + `</tr>`;
}
const PAGER = (next, disabled) => `<div><a title="Go to previous page" disabled="" class="x" href="/calendar/earnings?dateFrom=2026-12-01&amp;page=0"></a><a title="Go to page 1" class="x" href="/calendar/earnings?dateFrom=2026-12-01&amp;page=1"></a><a title="Go to next page" ${disabled ? 'disabled=""' : ''} class="x" href="/calendar/earnings?dateFrom=2026-12-01&amp;page=${next}"></a></div>`;
const page = (rows, pager = PAGER(2, true)) => `<html><head><title>Earnings Calendar</title></head><body><script type="application/json" data-ssr-props="ssr-island-1">{"view":"earnings","today":"2026-11-27"}</script><table><thead><tr><th>Ticker</th><th>Company</th><th>Time</th></tr></thead><tbody>${rows.join('')}</tbody></table>${pager}</body></html>`;

test('capNum reads Finviz market caps', () => {
  assert.equal(capNum('$241.32M'), 241320000);
  assert.equal(capNum('$215.70B'), 215700000000);
  assert.equal(capNum('$4.65M'), 4650000);
  assert.equal(capNum('$12.5K'), 12500);
  assert.equal(capNum('$1.2T'), 1.2e12);
  assert.equal(capNum('—'), 0);
  assert.equal(capNum(''), 0);
});

test('parses a real row: ticker from the link, text cells, dashes become null', () => {
  const p = parseEarnings(page([row({ s: 'TRX', name: 'TRX Gold Corp', t: 'AMC', cap: '$241.32M' })]));
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.rows[0], { s: 'TRX', n: 'TRX Gold Corp', t: 'AMC', c: 241320000, e: '$0.02', a: null, u: null, rv: '$33.54M', ra: null, ch: null });
  assert.equal(p.more, false); assert.equal(p.bad, 0);
});

test('keeps order, both time labels, actuals and surprise', () => {
  const p = parseEarnings(page([
    row({ s: 'CRWD', name: 'Crowdstrike Holdings Inc', t: 'BMO', cap: '$215.70B', est: '$0.31', act: LNK('<span class="text-green-500">$0.34</span>'), sur: LNK('<span>+9.11 %</span>'), chg: '<span>-8.92 %</span>' }),
    row({ s: 'MRVL', name: 'Marvell Technology Inc', t: 'AMC', cap: '$114.81B', est: '-$0.39' }),
  ]));
  assert.deepEqual(p.rows.map(r => r.s + r.t), ['CRWDBMO', 'MRVLAMC']);
  assert.equal(p.rows[0].a, '$0.34'); assert.equal(p.rows[0].u, '+9.11 %'); assert.equal(p.rows[0].ch, '-8.92 %');
  assert.equal(p.rows[1].e, '-$0.39'); assert.equal(p.rows[1].c, 114810000000);
});

test('a time other than BMO or AMC is kept as empty, a company name with an ampersand is decoded', () => {
  const p = parseEarnings(page([row({ s: 'ABC', name: 'AT&amp;T Holdings', t: '—', cap: '$1.00B' })]));
  assert.equal(p.rows[0].t, ''); assert.equal(p.rows[0].n, 'AT&T Holdings');
});

test('a short row is counted as bad, not as data', () => {
  const p = parseEarnings(page(['<tr class="styled-row"><td>X</td><td>Y</td></tr>', row({ s: 'OK', name: 'Ok Inc', t: 'BMO', cap: '$2.00B' })]));
  assert.equal(p.rows.length, 1); assert.equal(p.bad, 1);
});

test('pager: an enabled next link means more pages', () => {
  assert.equal(parseEarnings(page([row({ s: 'A', name: 'A', t: 'BMO', cap: '$1B' })], PAGER(2, false))).more, true);
  assert.equal(parseEarnings(page([row({ s: 'A', name: 'A', t: 'BMO', cap: '$1B' })], PAGER(2, true))).more, false);
});

test('validDay accepts a window around today and nothing else', () => {
  const now = Date.parse('2026-11-27T15:00:00Z');
  assert.equal(todayEt(now), '2026-11-27');
  for (const d of ['2026-11-27', '2026-12-01', '2026-11-19', '2026-12-25']) assert.equal(validDay(d, now), true, d);
  for (const d of ['2026-11-18', '2026-12-26', '2026-02-30', 'x', '', '2026-1-1', '../etc', null]) assert.equal(validDay(d, now), false, String(d));
});

const realFetch = globalThis.fetch;
const stub = (impl) => { let calls = 0; globalThis.fetch = async (u) => { calls++; return impl(u, calls); }; return () => calls; };
const ok = html => ({ ok: true, status: 200, text: async () => html });
const today = todayEt(), next = new Date(Date.parse(today + 'T12:00:00Z') + 4 * 864e5).toISOString().slice(0, 10);

test('route: builds, reuses the copy, asks for the right address and page', async () => {
  const urls = [];
  const calls = stub(u => { urls.push(u); return ok(page([row({ s: 'CPRT', name: 'Copart Inc', t: 'BMO', cap: '$30.72B' })], PAGER(2, false))); });
  const a = JSON.parse(await getEarnings({}, null, { day: next }));
  assert.equal(a.n, 1); assert.equal(a.more, true); assert.equal(a.rows[0].s, 'CPRT'); assert.equal(a.source, 'finviz');
  await getEarnings({}, null, { day: next });
  assert.equal(calls(), 1, 'second read comes from the copy');
  await getEarnings({}, null, { day: next, page: 2 });
  assert.equal(urls[0], `https://finviz.com/calendar/earnings?dateFrom=${next}`);
  assert.equal(urls[1], `https://finviz.com/calendar/earnings?dateFrom=${next}&page=2`);
  globalThis.fetch = realFetch;
});

test('route: a bad day is refused with status 400 and nothing is fetched', async () => {
  const calls = stub(() => ok(''));
  await assert.rejects(getEarnings({}, null, { day: '2030-01-01' }), e => e.status === 400);
  assert.equal(calls(), 0); globalThis.fetch = realFetch;
});

test('route: an empty earnings page is an empty day, an unrecognised page is an error', async () => {
  const d1 = new Date(Date.parse(today + 'T12:00:00Z') + 5 * 864e5).toISOString().slice(0, 10);
  const d2 = new Date(Date.parse(today + 'T12:00:00Z') + 6 * 864e5).toISOString().slice(0, 10);
  stub(() => ok(page([])));
  const e = JSON.parse(await getEarnings({}, null, { day: d1 }));
  assert.equal(e.n, 0); assert.deepEqual(e.rows, []);
  stub(() => ok('<html><title>Something else</title></html>'));
  await assert.rejects(getEarnings({}, null, { day: d2 }), /no earnings rows/);
  globalThis.fetch = realFetch;
});

test('route: a challenge page or HTTP error fails, and a later failure serves the last good copy flagged stale', async () => {
  const d = new Date(Date.parse(today + 'T12:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
  stub(() => ({ ok: false, status: 403, text: async () => '' }));
  await assert.rejects(getEarnings({}, null, { day: d }), /HTTP 403/);
  stub(() => ok(page([row({ s: 'NTAP', name: 'NetApp Inc', t: 'AMC', cap: '$32.41B' })])));
  const g = JSON.parse(await getEarnings({}, null, { day: d, fresh: true }));
  assert.equal(g.rows[0].s, 'NTAP');
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 3600e3;                         // five hours later: the copy is old and Finviz is down
  try {
    stub(() => { throw new Error('network down'); });
    const f = JSON.parse(await getEarnings({}, null, { day: d }));
    assert.equal(f.rows[0].s, 'NTAP'); assert.equal(f.stale, true);   // served at once while the refresh runs
    await new Promise(r => setTimeout(r, 20));
    const f2 = JSON.parse(await getEarnings({}, null, { day: d }));
    assert.equal(f2.rows[0].s, 'NTAP'); assert.match(f2.error, /network down/);
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
});
