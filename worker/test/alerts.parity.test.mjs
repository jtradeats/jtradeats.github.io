// P8.34 stage 1: the Worker's alert rules (src/alerts.js) against the page's own functions. The page's source (news.html at the repo root, or
// out/news.html here) is read, the real wireAlert, relCheck and remCheck are lifted out and run in a sandbox with their DOM calls replaced by
// recorders, and what they would show is compared with what alerts.js builds from the same input. A change made on only one side fails here.
// Run: node --test test/alerts.parity.test.mjs   (set NEWS_HTML=<path> when the page is not at ../../news.html or ../../out/news.html)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { buildAlerts, filterAlerts, wireGroup, wireSplit, GROUP_MS, TTL } from '../src/alerts.js';

const cand = [process.env.NEWS_HTML, new URL('../../news.html', import.meta.url).pathname, new URL('../../out/news.html', import.meta.url).pathname].filter(Boolean);
const pagePath = cand.find(p => existsSync(p));
const html = pagePath ? readFileSync(pagePath, 'utf8') : null;
const IND = JSON.parse(readFileSync(new URL('../config/indicators.json', import.meta.url), 'utf8'));
const skip = html ? false : 'news.html not found next to the worker folder (set NEWS_HTML)';

// ---- lift code out of the page ----
const line = re => { const m = html.match(re); assert.ok(m, 'not found in the page: ' + re); return m[0]; };
function fn(name) {   // a top-level function, by brace matching
  const i = html.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found in the page');
  let d = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i + 1, k + 1); }
  throw new Error('unbalanced ' + name);
}
function page() {
  const code = `(function(){
    let masterOn=true,remOn=true,fired=[],relFired=[],calData=null,_now=0;const TOASTS=[],NOTES=[],PANELS=[];
    const NOW=()=>_now,LS={s(){},g(){return''}},KEY='';
    const toast=a=>TOASTS.push(a),notify=(t,b)=>NOTES.push([t,b]),wirePanel=(w,g)=>PANELS.push(g);
    ${line(/const numOf=.*\n/)}
    ${line(/const wtok=.*\n/)}
    ${line(/const wsim=.*\n/)}
    ${line(/const WIRE_POLL=.*\n/)}
    ${line(/const WH_CUT=.*\n/)}
    ${line(/const REM=.*\n/)}
    ${line(/const SCK=.*\n/)}
    ${line(/const ETF=.*\n/)}
    ${line(/const p2=.*\n/)}
    ${line(/function etP\(.*\n/)}
    ${line(/const etClock=.*\n/)}
    ${html.match(/const wireSplit=p=>\{[\s\S]*?\n\};/)[0]}
    ${fn('wireGroup')}
    ${fn('wireAlert')}
    ${fn('scenIdx')}
    ${fn('relHead')}
    ${fn('takeaway')}
    ${fn('relCheck')}
    ${fn('remCheck')}
    return { TOASTS, NOTES, PANELS, GROUP_MS, wireSplit,
      set(now,cal){ _now=now; calData=cal; fired=[]; relFired=[]; TOASTS.length=NOTES.length=PANELS.length=0; },
      relCheck, remCheck, wireAlert };
  })()`;
  return vm.runInNewContext(code, { Intl, Date, Math, JSON, String, Number, Set, Map, Array, Object, parseFloat, isNaN, console }, { timeout: 5000 });
}

const T0 = Date.parse('2026-11-25T13:30:00Z');
const kv = (alerts, k) => alerts.filter(a => a.kind === k);

test('the page and the Worker use the same constants', { skip }, () => {
  const P = page();
  assert.equal(P.GROUP_MS, GROUP_MS);
  assert.match(html, /GROUP_SIM=0\.6/); assert.match(html, /WH_CUT=160/); assert.match(html, /REM=\[15,5,0\]/); assert.match(html, /relFired\.includes\(e\.id\)/);
});

test('Walter Bloomberg: every new post is an alert, with the page headline; the notification is the newest post', { skip }, () => {
  const P = page(), now = T0;
  const nw = [
    { id: 105, t: now - 10e3, text: 'US 10-YEAR YIELD TOPS 4.50%\nSecond line with more' },
    { id: 104, t: now - 40e3, text: 'x'.repeat(200) },
    { id: 103, t: now - 70e3, text: '' , media: true },
    { id: 102, t: now - 90e3, text: 'FED\'S WILLIAMS: POLICY WELL POSITIONED' },
  ];
  P.set(now, null); P.wireAlert({ hot: false, name: 'Walter Bloomberg', recent: [] }, nw);
  const heads = P.PANELS[0].map(g => P.wireSplit(g.p).head);
  const a = kv(buildAlerts({ now, dm: nw }), 'wire');
  assert.deepEqual(a.map(x => x.h), heads, 'same headlines in the same order (newest first)');
  assert.deepEqual([...P.NOTES[0]], [a[0].nt, a[0].nb], 'the browser notification: title and the newest headline');
  assert.deepEqual(a.map(x => x.id), ['dm:105', 'dm:104', 'dm:103', 'dm:102']);
  assert.ok(a.every(x => x.src === 'Walter Bloomberg'));
});

test('FinancialJuice: every post (marked or not), one alert per story, same grouping as the page', { skip }, () => {
  const P = page(), now = T0;
  const hot = (id, ago, text) => ({ id, t: now - ago, text, hot: true });
  const nw = [
    { id: 211, t: now - 3e3, text: 'US 10-YEAR AUCTION DRAWS STRONG DEMAND', hot: false },   // no red mark: it alerts too (24 Nov)
    hot(210, 5e3, 'US CPI MOM 0.3% VS 0.2% EXPECTED, PRIOR 0.1%'),
    hot(209, 20e3, 'US CPI MOM 0.3% VS 0.2% EXPECTED, PRIOR 0.1% (CORRECTED)'),
    hot(208, 50e3, 'ISRAEL STRIKES TARGETS IN LEBANON, SIRENS SOUND'),
    hot(207, 400e3, 'ISRAEL STRIKES TARGETS IN LEBANON, SIRENS SOUND'),
  ];
  P.set(now, null); P.wireAlert({ hot: true, name: 'FinancialJuice', recent: [] }, nw);
  const groups = P.PANELS[0];
  const a = kv(buildAlerts({ now, fj: nw }), 'fj');
  assert.equal(a.length, 4, 'the unmarked post, the CPI story (two posts), and two Lebanon stories (the posts are 350 s apart, beyond the 2-minute grouping window)');
  assert.ok(a.some(x => x.h.startsWith('US 10-YEAR AUCTION')), 'a post without the red mark is an alert');
  assert.match(html, /const FJW=mkWire\(\{[^\n]*pick:p=>true/, 'the page picks every FinancialJuice post');
  assert.equal(a.length, groups.length, 'same number of stories');
  assert.deepEqual(a.map(x => x.h), [...groups.map(g => P.wireSplit(g.p).head)]);
  assert.deepEqual(a.map(x => x.n), [...groups.map(g => g.n)]);
  assert.deepEqual([...P.NOTES[0]], [a[0].nt, a[0].nb]);
  assert.ok(a.every(x => x.id.startsWith('fj:')));
  // the story's id is its first post, so a later repeat of the same story is the same id (a client shows it once)
  const later = kv(buildAlerts({ now: now + 30e3, fj: [hot(212, -20e3, nw[1].text), ...nw] }), 'fj').find(x => x.h.startsWith('US CPI'));
  assert.equal(later.id, a.find(x => x.h.startsWith('US CPI')).id);
});

test('reminders: 15 min, 5 min and at the release; identical text to the page, one alert per moment', { skip }, () => {
  const P = page();
  const rel = Date.parse('2026-11-25T13:30:00Z');
  const ev = (o) => ({ id: 'e' + (o.title || 'x'), t: rel, imp: 3, src: 'sched', title: 'Core PCE Price Index m/m', fc: '0.2%', pv: '0.3%', agency: 'BEA', k: 'pce', d: '2026-11-25', ...o });
  for (const [label, events, now] of [
    ['15 min, one release', [ev({})], rel - 15 * 60e3 + 20e3],
    ['5 min, one release with no forecast', [ev({ fc: '', title: 'Goods Trade Balance' })], rel - 5 * 60e3 + 40e3],
    ['at the release, two releases', [ev({}), ev({ title: 'Unemployment Claims', fc: '225K', pv: '220K' })], rel + 30e3],
    ['at 15 min, two releases', [ev({}), ev({ title: 'Unemployment Claims', fc: '225K', pv: '220K' })], rel - 15 * 60e3 + 90e3],
  ]) {
    P.set(now, { events }); P.remCheck();
    const a = kv(buildAlerts({ now, events }), 'remind');
    assert.equal(a.length, P.TOASTS.length, label + ': one alert');
    assert.equal(a[0].tag, P.TOASTS[0].tag, label); assert.equal(a[0].h, P.TOASTS[0].h, label); assert.equal(a[0].s, P.TOASTS[0].s, label); assert.equal(a[0].src, P.TOASTS[0].src, label);
  }
  // outside the page's 150 s the page stays quiet; the Worker waits up to TTL.rem for a poller that is a little late
  P.set(rel - 15 * 60e3 + 200e3, { events: [ev({})] }); P.remCheck(); assert.equal(P.TOASTS.length, 0);
  assert.equal(kv(buildAlerts({ now: rel - 15 * 60e3 + 200e3, events: [ev({})] }), 'remind').length, 1);
  assert.equal(kv(buildAlerts({ now: rel - 15 * 60e3 + TTL.rem + 1000, events: [ev({})] }), 'remind').length, 0, 'too late to be useful');
  // the feed-only rows and the medium and low impact ones never remind
  assert.equal(kv(buildAlerts({ now: rel - 5 * 60e3 + 10e3, events: [ev({ src: 'feed' }), ev({ imp: 2, title: 'Y' })] }), 'remind').length, 0);
  // the id is the same on every call within the window (a client shows it once)
  const x = kv(buildAlerts({ now: rel - 5 * 60e3 + 10e3, events: [ev({})] }), 'remind')[0], y = kv(buildAlerts({ now: rel - 5 * 60e3 + 70e3, events: [ev({})] }), 'remind')[0];
  assert.equal(x.id, y.id);
});

test('release alerts: every family, every scenario, every direction: headline, lines and takeaway match the page', { skip }, () => {
  const P = page(), now = T0 + 120e3;
  const rows = [];
  let n = 0;
  for (const fam of Object.keys(IND.fams)) for (const [ac, fc, pv] of [['0.5%', '0.3%', '0.2%'], ['0.3%', '0.3%', '0.2%'], ['0.1%', '0.3%', '0.2%'], ['155K', '', '140K'], ['', '0.3%', '0.2%']]) {
    for (const dir of ['inv', 'infl', 'grow', undefined]) {
      n++;
      rows.push({ id: 'r' + n, t: T0, imp: 3, src: 'sched', title: 'Indicator ' + n, ac: ac || null, fc, pv, fam, dir, k: 'k' + n, d: '2026-11-25', agency: 'BLS', sr: { ac: 'FRED' } });
    }
  }
  rows.push({ id: 'cl', t: T0, imp: 3, src: 'sched', title: 'Initial Jobless Claims', ac: '231K', fc: '225K', pv: '220K', fam: 'claims', dir: 'inv', k: 'claims', d: '2026-11-25', agency: 'DOL' });
  rows.push({ id: 'cl2', t: T0, imp: 3, src: 'sched', title: 'Initial Jobless Claims', ac: '211K', fc: '225K', pv: '220K', fam: 'claims', dir: 'inv', k: 'claims2', d: '2026-11-25', agency: 'DOL' });
  let checked = 0;
  for (const e of rows) {
    P.set(now, { events: [e], fams: IND.fams }); P.relCheck();
    const a = kv(buildAlerts({ now, events: [e], fams: IND.fams }), 'release');
    if (!P.TOASTS.length) { assert.equal(a.length, 0, 'the page makes no alert for ' + e.id + ', nor does the Worker'); continue; }
    assert.equal(a.length, 1, e.id);
    assert.equal(a[0].h, P.TOASTS[0].h, e.id + ' headline'); assert.equal(a[0].s, P.TOASTS[0].s, e.id + ' text');
    assert.equal(a[0].tag, P.TOASTS[0].tag); assert.equal(a[0].src, P.TOASTS[0].src);
    assert.deepEqual([a[0].nt, a[0].nb], [...P.NOTES[0]], e.id + ' notification');
    checked++;
  }
  assert.ok(checked > 100, 'compared ' + checked + ' alerts');
});

test('release alerts: a report with several rows is one alert listing up to four rows; FJ-sourced figures say so', { skip }, () => {
  const P = page(), now = T0 + 60e3;
  const mk = (i, o = {}) => ({ id: 'c' + i, t: T0, imp: 3, src: 'sched', title: 'CPI part ' + i, ac: (0.2 + i / 10).toFixed(1) + '%', fc: '0.2%', pv: '0.1%', fam: 'infl', dir: 'infl', k: 'cpi', d: '2026-11-25', agency: 'BLS', sr: { ac: 'FRED' }, ...o });
  const events = [mk(1), mk(2, { sr: { ac: 'FJ' } }), mk(3), mk(4), mk(5)];
  P.set(now, { events, fams: IND.fams }); P.relCheck();
  const a = kv(buildAlerts({ now, events, fams: IND.fams }), 'release');
  assert.equal(a.length, 1); assert.equal(P.TOASTS.length, 1);
  assert.equal(a[0].s, P.TOASTS[0].s); assert.equal(a[0].s.split('\n').length, 4 + 1, 'four rows and the takeaway');
  assert.match(a[0].s, /CPI part 2: 0\.4% \(FinancialJuice, unconfirmed\)/);
  assert.equal(a[0].id, 'rel|cpi|2026-11-25');
});

test('release alerts: not for a row that is not an official release, has no actual, is older than 45 min or is not high impact', { skip }, () => {
  const P = page(), now = T0 + 46 * 60e3;
  const base = { id: 'z', t: T0, imp: 3, src: 'sched', title: 'T', ac: '1%', fc: '0.5%', fam: 'infl', k: 'k', d: '2026-11-25' };
  for (const e of [{ ...base }, { ...base, t: now - 10 * 60e3, src: 'feed' }, { ...base, t: now - 10 * 60e3, hol: true }, { ...base, t: now - 10 * 60e3, imp: 2 }, { ...base, t: now - 10 * 60e3, ac: null }, { ...base, t: now + 120e3 }]) {
    P.set(now, { events: [e], fams: IND.fams }); P.relCheck();
    assert.equal(P.TOASTS.length, 0, 'page: ' + JSON.stringify(e));
    assert.equal(kv(buildAlerts({ now, events: [e], fams: IND.fams }), 'release').length, 0, 'worker: ' + JSON.stringify(e));
  }
});

test('corrected figure: the page text, kept for 6 hours, listed whatever the since filter says', { skip }, () => {
  const P = page(), now = T0 + 3 * 36e5;
  const e = { id: 'gdp', t: T0, imp: 3, src: 'sched', title: 'GDP q/q (second estimate)', ac: '3.8%', wfix: '3.6%', fc: '3.6%', agency: 'BEA', k: 'gdp', d: '2026-11-25', fam: 'gdp' };
  P.set(now, { events: [e], fams: IND.fams }); P.relCheck();
  const t = P.TOASTS.find(x => /CORRECTED/.test(x.tag)), nt = P.NOTES.find(x => /^Corrected/.test(x[0]));
  const a = kv(buildAlerts({ now, events: [e], fams: IND.fams }), 'fix');
  assert.equal(a.length, 1); assert.equal(a[0].h, t.h); assert.equal(a[0].s, t.s); assert.equal(a[0].tag, t.tag); assert.deepEqual([a[0].nt, a[0].nb], [...nt]);
  assert.equal(filterAlerts(buildAlerts({ now, events: [e], fams: IND.fams }), now - 1000).filter(x => x.kind === 'fix').length, 1);
  assert.equal(kv(buildAlerts({ now: T0 + 7 * 36e5, events: [e], fams: IND.fams }), 'fix').length, 0, 'older than 6 h');
});

test('what only the Worker does: freshness limits, the since filter, release dated by the first sighting, no duplicate ids, newest first', { skip }, () => {
  const now = T0;
  const dm = [{ id: 3, t: now - 5 * 60e3, text: 'fresh' }, { id: 2, t: now - TTL.wire - 1000, text: 'old' }, { id: 1, text: 'no time' }];
  assert.deepEqual(kv(buildAlerts({ now, dm }), 'wire').map(x => x.id), ['dm:3'], 'an old post and a post without a time are not alerts');
  const all = buildAlerts({ now, dm: [{ id: 5, t: now - 4e3, text: 'b' }, { id: 4, t: now - 9e3, text: 'a' }] });
  assert.deepEqual(filterAlerts(all, now - 5e3).map(x => x.id), ['dm:5'], 'since: only what happened after');
  assert.equal(filterAlerts(all, 0).length, 2); assert.equal(new Set(all.map(x => x.id)).size, all.length);
  assert.ok(all[0].t >= all[1].t, 'newest first');
  const ev = { id: 'r1', t: T0, imp: 3, src: 'sched', title: 'PPI', ac: '0.4%', fc: '0.2%', fam: 'infl', dir: 'infl', k: 'ppi', d: '2026-11-25' };
  const r = kv(buildAlerts({ now: T0 + 5 * 60e3, events: [ev], fams: IND.fams, seen: { r1: T0 + 3 * 60e3 } }), 'release')[0];
  assert.equal(r.t, T0 + 3 * 60e3, 'dated by when the actual was first seen');
  assert.equal(kv(buildAlerts({ now: T0 + 5 * 60e3, events: [ev], fams: IND.fams }), 'release')[0].t, T0, 'no sighting on file: the release time');
  assert.deepEqual(buildAlerts({ now, dm: undefined, fj: null, events: undefined }), [], 'missing inputs give no alerts, not an error');
});

test('every alert has the fields a client needs, as plain strings', { skip }, () => {
  const now = T0, rel = T0 + 20 * 60e3;
  const events = [{ id: 'a', t: rel, imp: 3, src: 'sched', title: 'X', fc: '1%', agency: 'BEA', k: 'x', d: '2026-11-25' }, { id: 'b', t: T0 - 60e3, imp: 3, src: 'sched', title: 'Y', ac: '2%', fc: '1%', fam: 'infl', dir: 'infl', k: 'y', d: '2026-11-25', wfix: '1.9%' }];
  const all = buildAlerts({ now: now + 5 * 60e3 + 30e3, dm: [{ id: 1, t: now, text: 'hello' }], fj: [{ id: 2, t: now, text: 'red post', hot: true }], events, fams: IND.fams });
  assert.deepEqual(new Set(all.map(x => x.kind)), new Set(['wire', 'fj', 'remind', 'release', 'fix']));
  for (const a of all) for (const k of ['id', 'kind', 'src', 'tag', 'h', 'nt', 'nb']) assert.equal(typeof a[k], 'string', a.id + '.' + k);
  for (const a of all) { assert.equal(typeof a.t, 'number'); assert.equal(typeof a.s, 'string'); assert.ok(a.h.length > 0 && a.nt.length > 0, a.id); }
});
