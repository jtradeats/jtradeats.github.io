// Finviz economic calendar (plan P8.44): a second, independent source of forecast, previous and actual for the calendar card.
// Why: Fair Economy / Forex Factory is the only forecast source, it answers HTTP 429 to the Worker most of the time, and its file simply lacks some releases
// (no Core PCE y/y row; durable goods and new home sales not listed yet on 25 Nov). Finviz's page /calendar/economic is server-rendered HTML: one table per day with
// Release, Impact, For, Actual, Expected, Prior, in New York time, and answered the Worker with HTTP 200 in 272 ms (probe of 25 Nov, 235 KB, not a challenge page).
// "Expected" is Trading Economics' consensus, "Prior" is the revised previous. Finviz has no S&P Global PMI rows (checked 25 Nov).
//
// How it is used (decided with J, 25 Nov):
//   - forecast and previous: laid over the schedule BEFORE the Fair Economy copy, so Forex Factory still wins where both have a number (its figures match the reference calendar
//     better: claims 201K) and Finviz fills what Forex Factory lacks. Tag "Finviz".
//   - actual: never part of the overlay. applyFvActuals() runs after the wire: it fills a blank actual or a typed placeholder (tag "Finviz"), and for a row the wire filled it
//     is a second opinion: same number -> e.cf = 'Finviz' (the page shows "fj ✓"), different number -> the row is flagged and the wire's number stays until an official source settles it.
//   - the official FRED/EIA number still outranks both (official.js treats a "Finviz" actual like a wire actual).
// Finviz's terms limit automated access; this is one page per refresh (this week every 30 min, next week every 2 h), a polite cadence, and a failed or odd page changes nothing.
// Pure functions (parse, normalise, apply) are tested; the fetch and the state are at the bottom.

import { etToMs, etParts, candidates, fmtVal } from './schedule.js';
import { mergeFeed, ffHot } from './feedpoll.js';

export const FV_KV = 'calendar:finviz';
const BASE = 'https://finviz.com/calendar/economic?dateFrom=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const FV_SLOW = 30 * 60e3;      // quiet hours: this week and next week
export const FV_FAST = 5 * 60e3;       // a release window (the same window as the Forex Factory poll): this week only
export const FV_RETRY = 10 * 60e3, FV_RETRY_HOT = 5 * 60e3;
export const FV_USE_MAX = 12 * 3600e3;   // a copy older than this is not laid over the schedule (the same limit as the Forex Factory copy)
const FV_MIN_ROWS = 8;                 // a week's page that parses to fewer event rows than this is treated as a failure (markup change), never as "no releases"
const KV_GAP = 10 * 60e3;              // one KV write per 10 minutes at most, and only when a figure changed
const TIMEOUT = 6000;

// kinds Finviz is not asked about: central-bank text and the Treasury auctions have their own sources, and a rate prints differently ("4.00%")
const SKIP_KINDS = new Set(['fomc', 'fomc_s', 'minutes', 'speech', 'hol', 'auc10', 'auc30']);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ENT = { '&amp;': '&', '&#39;': "'", '&#x27;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
// one pass: tags become spaces, the few entities Finviz uses are decoded, runs of white space collapse
const text = s => String(s).replace(/<[^>]*>|&(?:amp|#39|#x27|quot|lt|gt|nbsp);/g, m => (m.charCodeAt(0) === 60 ? ' ' : ENT[m])).replace(/\s{2,}|\n/g, ' ').trim();
const p2 = n => (n < 10 ? '0' : '') + n;

// "3.2%", "0.65M", "203K", "103.3", "-0.6%" -> { n, s }; "-" or empty or anything else -> null. A range ("4.25-4.50%") is not a number.
export function fvToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '-') return null;
  const m = /^(-?\d[\d,]*\.?\d*)\s*([%KMBT]?)(.*)$/i.exec(s);
  if (!m || /\d/.test(m[3])) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? { n, s: m[2].toUpperCase() } : null;
}

// The week's HTML -> [{ id, t, title, per, ac, fc, pv }] (ac/fc/pv are Finviz's own text or null). dateFrom: the Monday the page was asked for (gives the year).
// Structure (25 Nov probe): <table> per day, first <th> "Mon Nov 23"; each event <tr id="event-398221"> with cells time, release, impact, for, actual, expected, prior, bell.
// Written with indexOf, not a regex over the whole 235 KB page: the free plan allows 10 ms CPU per invocation (plan §3.2); 1.5 ms warm on a page that size, cold about 4.
export function parseFvCal(html, dateFrom) {
  html = String(html || '');
  const rows = [], y0 = +String(dateFrom).slice(0, 4), m0 = +String(dateFrom).slice(5, 7);
  let pos = 0, ymd = null;
  for (;;) {
    const tb = html.indexOf('<table', pos), ev = html.indexOf('id="event-', pos);
    if (ev < 0 && tb < 0) break;
    if (tb >= 0 && (ev < 0 || tb < ev)) {                       // a new day's table: its first <th> says which day
      const a = html.indexOf('<th', tb), b = a < 0 ? -1 : html.indexOf('</th>', a);
      pos = tb + 6; ymd = null;
      if (b < 0) continue;
      const dl = /^[A-Za-z]{3}\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2})$/.exec(text(html.slice(a, b)));
      if (dl && MONTHS[dl[1].toLowerCase()]) {
        const mo = MONTHS[dl[1].toLowerCase()];
        ymd = { mo, d: +dl[2], y: mo < m0 - 6 ? y0 + 1 : mo > m0 + 6 ? y0 - 1 : y0 };   // a week that crosses New Year
      }
      pos = b;
      continue;
    }
    const end = html.indexOf('</tr>', ev);
    if (end < 0) break;
    pos = end;
    if (!ymd) continue;
    const id = +html.slice(ev + 10, ev + 22).replace(/\D.*$/, '');
    const c = [];   // cells 0 time, 1 release, 3 for, 4 actual, 5 expected, 6 prior (2 impact and 7 bell are skipped: they hold only icons)
    let q = ev;
    for (let k = 0; k < 7; k++) {
      const td = html.indexOf('<td', q);
      if (td < 0 || td > end) break;
      const g = html.indexOf('>', td) + 1, h = html.indexOf('</td>', g);
      if (h < 0) break;
      c.push(k === 2 ? '' : text(html.slice(g, h)));
      q = h;
    }
    if (c.length < 7 || !c[1]) continue;
    const tm = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(c[0]);
    let h = 12, mi = 0;   // no clock time ("All Day", "Tentative"): noon, and the calendar never compares times of a Finviz row
    if (tm) { h = +tm[1] % 12 + (/p/i.test(tm[3]) ? 12 : 0); mi = +tm[2]; }
    const t = etToMs(`${ymd.y}-${p2(ymd.mo)}-${p2(ymd.d)}T${p2(h)}:${p2(mi)}`);
    if (t == null) continue;
    const val = x => (x && x !== '-' ? x : null);   // an empty cell shows a muted "-"
    rows.push({ id, t, title: c[1].slice(0, 80), per: c[3] || null, ac: val(c[4]), fc: val(c[5]), pv: val(c[6]) });
  }
  return rows;
}

// a Finviz token -> the text the calendar shows, in the row's own unit (a K row gets "650K" from "0.65M"); null when the unit does not fit the row
function inUnit(tok, u, dp) {
  if (!tok) return null;
  const { n, s } = tok;
  let v = null;
  if (u === '%') v = s === '%' ? n : null;
  else if (u === 'K') v = s === 'K' ? n : s === 'M' ? n * 1000 : null;
  else if (u === 'M') v = s === 'M' ? n : s === 'K' ? n / 1000 : null;
  else v = s === '' ? n : null;
  if (v == null) return null;
  return u === 'M' && dp != null ? v.toFixed(dp) + 'M' : fmtVal(v, u);
}

// rows -> the shape the overlay reads ({ t, title, imp, fc, pv, ac }), only for titles that belong to a row the dashboard shows. imp is always 1 (Low):
// the overlay never turns a Finviz-only row into an "extras" line, never raises a feed_date warning for one, and (src: 'Finviz', noTime) never compares its clock time.
export function normFv(rows, IND) {
  const out = [];
  for (const r of rows || []) {
    const cands = candidates(IND, r.title).filter(x => !SKIP_KINDS.has(x.k));
    if (!cands.length) continue;
    const row = (IND.kinds[cands[0].k].rows || []).find(x => x.id === cands[0].r) || {}, u = row.u || '', dp = row.dp;
    out.push({ t: r.t, title: r.title, imp: 1, per: r.per, fc: inUnit(fvToken(r.fc), u, dp), pv: inUnit(fvToken(r.pv), u, dp), ac: inUnit(fvToken(r.ac), u, dp) });
  }
  return out.sort((a, b) => a.t - b.t);
}

// what the overlay gets: forecast and previous only (a Finviz actual goes through applyFvActuals)
const OV = new WeakMap();
export function fvOverlayRows(events) {
  if (!events) return [];
  let c = OV.get(events);
  if (!c) { c = events.map(r => ({ ...r, ac: null })); OV.set(events, c); }
  return c;
}

const num = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

// After the wire has filled its blanks. events: calendar events; rows: normFv() output (with ac). Mutates the events. Returns { n, confirmed, issues }.
export function applyFvActuals(events, rows, IND, now) {
  const byId = new Map();
  for (const e of events) if (!e.hol && e.src !== 'feed') byId.set(e.id, e);
  let n = 0, confirmed = 0;
  const issues = [];
  for (const r of rows || []) {
    if (r.ac == null) continue;
    const iso = etParts(r.t).iso, cands = candidates(IND, r.title);
    const c = cands.find(x => byId.has(`${x.k}|${iso}|${x.r}`));
    if (!c) continue;
    const e = byId.get(`${c.k}|${iso}|${c.r}`);
    if (now < e.t - 60e3) continue;                      // an "actual" before the release cannot be one
    const sr = e.sr || (e.sr = {});
    if (e.ac == null || (sr.ac === 'ref' && e.t > now - 3 * 864e5)) { e.ac = r.ac; sr.ac = 'Finviz'; n++; continue; }
    if (sr.ac === 'FJ') {                                // the wire's first figure: Finviz agrees (confirmed) or does not (flagged, the wire's figure stays until an official source settles it)
      const a = num(e.ac), b = num(r.ac);
      if (Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))) { if (e.cf !== 'Finviz') { e.cf = 'Finviz'; confirmed++; } }
      else if (Number.isFinite(a) && Number.isFinite(b)) {
        e.flag = `FinancialJuice said ${e.ac}, Finviz says ${r.ac}; showing ${e.ac}`;
        issues.push({ lvl: 'warn', code: 'wire_finviz_diff', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}. The official figure will settle it where one exists.` });
      }
    }
  }
  return { n, confirmed, issues };
}

// ---------------------------------------------------------------- fetch and state (Worker only)
// One page per invocation (the free plan's 10 ms CPU budget, plan §3.2): this week's page is the one asked for (every 30 min, every 5 min in a release window); next week's page
// is asked for only when this week's is not due, and then at most every 2 hours (its figures arrive slowly).

export const FV_NEXT = 2 * 3600e3;
export const fvState = { events: null, at: 0, nxtAt: 0, failAt: 0, err: null, status: 'none', rows: 0, inflight: null, seeded: false, lastKv: 0, sig: '' };

const sigOf = ev => ev.map(r => `${r.t}|${r.title}|${r.fc}|${r.pv}|${r.ac}`).join('\n');
const isoAdd = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export function mondayOf(now) { const p = etParts(now); return isoAdd(p.iso, -((p.dow + 6) % 7)); }

async function fetchWeek(dateFrom) {
  const r = await fetch(BASE + dateFrom, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from finviz.com`);
  const html = await r.text();
  if (/Just a moment|cf-chl|Attention Required|captcha/i.test(html.slice(0, 4000)) && !/id="event-/.test(html)) throw new Error('Finviz sent a challenge page');
  return parseFvCal(html, dateFrom);
}

// The shared copy in KV, taken over when it is newer than the one in memory (a cold isolate has nothing until it reads it). Awaited once before the first overlay.
export async function fvSeed(env) {
  if (fvState.seeded) return;
  fvState.seeded = true;
  if (!(env && env.MARKET_KV)) return;
  try {
    const sn = await env.MARKET_KV.get(FV_KV, 'json');
    if (sn && Array.isArray(sn.events) && sn.events.length && sn.at > fvState.at) { fvState.events = sn.events; fvState.at = sn.at; fvState.nxtAt = sn.nxtAt || 0; fvState.status = 'ok'; fvState.sig = sigOf(sn.events); }
  } catch (e) { /* KV unavailable: carry on */ }
}

// Pure: what to ask for now. Returns 'cur', 'nxt' or null.
export function fvDue(st, now, hot) {
  if (st.failAt && now - st.failAt < (hot ? FV_RETRY_HOT : FV_RETRY)) return null;
  if (!st.events || now - st.at >= (hot ? FV_FAST : FV_SLOW)) return 'cur';
  if (!hot && now - st.nxtAt >= FV_NEXT) return 'nxt';
  return null;
}

async function refresh(env, IND, hot) {
  const now = Date.now();
  await fvSeed(env);
  const what = fvDue(fvState, now, hot);
  if (!what) return;
  try {
    const mon = mondayOf(now), nxtMon = isoAdd(mon, 7);
    if (what === 'cur') {
      const rows = await fetchWeek(mon);
      if (rows.length < FV_MIN_ROWS) throw new Error(`parser found ${rows.length} event rows (the markup may have changed)`);
      fvState.events = mergeFeed(fvState.events, normFv(rows, IND));   // next week's rows from the last next-week poll stay
      fvState.at = Date.now(); fvState.rows = rows.length; fvState.failAt = 0; fvState.err = null; fvState.status = 'ok';
    } else {
      fvState.nxtAt = Date.now();                                       // asked now, whatever the answer: a missing page is not retried every 5 minutes
      const rows = await fetchWeek(nxtMon).catch(() => []);             // next week's page may not exist yet
      if (rows.length) {
        const from = etToMs(nxtMon + 'T00:00');
        fvState.events = (fvState.events || []).filter(r => r.t < from).concat(normFv(rows, IND)).sort((a, b) => a.t - b.t);
      }
    }
    const sig = sigOf(fvState.events || []);
    if (env && env.MARKET_KV && sig !== fvState.sig && Date.now() - fvState.lastKv > KV_GAP) {
      fvState.sig = sig; fvState.lastKv = Date.now();
      try { await env.MARKET_KV.put(FV_KV, JSON.stringify({ at: fvState.at, nxtAt: fvState.nxtAt, events: fvState.events })); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    fvState.failAt = Date.now(); fvState.err = String(e.message).slice(0, 160);
    fvState.status = /HTTP 4\d\d/.test(fvState.err) ? 'blocked' : 'unavailable';
  }
}

// Bring the copy up to date if it is due. Never throws. scheduleEvents: the schedule's events (a release window is open when one is about to happen or just happened).
export function fvRefresh(env, ctx, IND, scheduleEvents, now = Date.now()) {
  if (!fvState.inflight) {
    fvState.inflight = refresh(env, IND, ffHot(scheduleEvents, now)).finally(() => { fvState.inflight = null; });
    if (ctx) ctx.waitUntil(fvState.inflight);
  }
  return fvState.inflight;
}

// for /calendar?debug=1 and /health
export function fvHealth(now = Date.now()) {
  return { status: fvState.events && now - fvState.at > 3 * FV_SLOW ? 'stale' : fvState.status, age_s: fvState.at ? Math.round((now - fvState.at) / 1000) : null,
    next_age_s: fvState.nxtAt ? Math.round((now - fvState.nxtAt) / 1000) : null, rows: (fvState.events || []).length, week_rows: fvState.rows, error: fvState.err };
}
