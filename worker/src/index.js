// Market Dashboard Worker: primary data path for news.html (JS port of dashboard_data.py).
// GET /market -> JSON for the page. GET /feed -> both Telegram wires in one answer: DeItaone at the top level, FinancialJuice under "fj" (flagged posts carry hot:true); ?ch=<channel> returns one channel alone. GET /calendar -> release schedule with forecast/previous/actual (?debug=1 shows provider samples and unmatched titles). GET /curve -> Treasury yield curve, spreads and changes (official close, cross-checked against FRED T10Y2Y; plan P6). GET /sectors -> the 11 sector ETFs plus SPY (plan P4). GET /weekly -> week open vs current for NQ, ES, DOW, RTY, GC, CL (plan P5); /sectors, /weekly, /market, /calendar, /curve and /feed accept ?fresh=1 (manual refresh from the page, never from a timer). GET /finviz -> Finviz news headlines (time, source, link) parsed from finviz.com/news, cached, last good copy kept (?debug=1 shows row counts). GET /health -> small status object, read from stored state (KV and D1).
// No API keys needed. Optional KV binding named MARKET_KV keeps a snapshot across cold starts.

import SYMBOLS from '../config/symbols.json';
import SCHEDULE from '../config/schedule.json';
import INDICATORS from '../config/indicators.json';
import RESULTS from '../config/results.json';
import HISTORY from '../config/schedule_history.json';   // last month's releases, which schedule.json (it starts on 2 Nov) does not hold (P8.40)
import POLICY_CFG from '../config/policy.json';   // FOMC decision dates already held (plan P8.9)
import { etToMs, etParts, expand, audit, overlay, normFair, applyResults, typedReplaced, chainPrevious } from './schedule.js';
import { fvRefresh, fvSeed, fvState, fvHealth, fvOverlayRows, applyFvActuals, FV_USE_MAX } from './fvcal.js';   // Finviz economic calendar: forecasts, revised previous, second opinion on actuals (P8.44)
import { ffHot, ffTtl, ffRetry, ffStale, mergeFeed } from './feedpoll.js';   // Forex Factory refresh plan: this week's file every 5 min around a release (P8.24)
import { FP_KV, newFirst, fromKv, recordPrev, recordActual, prune as pruneFirst, lookups as firstLookups } from './firstprint.js';   // first prints: what a release showed before any revision (P8.23)
import { beat, beats, prunePosts, postsSummary, postsError, recordLag, loadLag, loadPosts, loadLagSeen } from './posts.js';   // Telegram posts and the poller's heartbeats in D1 (plan P8.31)
import { LG_KV, newLedger, fromKv as ledgerFromKv, recordLedger, applyLedger, pruneLedger, forecastGaps, rankOf } from './ledger.js';   // the best actual each release has shown, kept in KV (plan P8.30)
import { buildAlerts, filterAlerts, filterPrefs, PREF_KINDS, REM_MENU, reminderIdsDue, testAlert } from './alerts.js';   // the alerts, decided here instead of in each open page (plan P8.34)
import { checkKey, getVapid, validEndpoint, saveSub, dropSub, loadSubs, loadTests, recordTest, sendAll, pushNew, anyUnsent, pushHealth, loadPrefs, savePrefs } from './push.js';   // Web Push to the phone (plan P8.34 stages 3 and 4)
import { loadSettings, saveSettings, applySettings, remindWanted, wantedMins, listDevices, epOf, deviceId, REMIND_MINS } from './pushctl.js';   // push control center: master switch, reminder choices, device list (25 Nov)
import { POLICY_KV, SERIES_U, SERIES_L, decisionList, computeFacts, parseVotes, statementUrl, policyBackdrop, policyIssues } from './policy.js';   // the policy backdrop built from FRED and the FOMC schedule (plan P8.9)
import { SPEC as OFF_SPEC, SERIES as OFF_SERIES, parseFredCsv, parseFredJson, fredApiUrl, eiaApiUrl, parseEiaJson, applyOfficial, markPending, VINTAGE_SERIES, fredVintageUrl, parseFredVintage, fredAsOfUrl, histNumbers, HIST_MIN_AGE } from './official.js';
import { SYNC_KEY, runBls, runFred, runTreasury, runProvider, mergeSchedule, diffSchedules, syncIssues, syncSummary, dueSources } from './schedule_sync.js';   // nightly schedule sync (plan P2, P3)
import { getFeed, getFeeds, feedHealth, feedWindow, CHANNELS } from './feed.js';   // DeItaone and FinancialJuice wires via the Telegram mirror (plan 1.5)
import { WIRE_KV, WIRE_KEYS, applyWire, newMemo, recordConfirms, wireSummary, unmatchedUsNames } from './wire.js';   // FinancialJuice actuals (plan P8.19 stage 2)
import { makeSectors } from './sectors.js';   // /sectors (plan P4)
import { makeWeekly } from './weekly.js';   // /weekly (plan P5)
import { buildCurve, parseTreasuryCsv } from './curve.js';   // /curve (plan P6)
import { tvIngest, loadTv, tvOverlay, tvWeekly, tvMarket, tvHealth } from './tv.js';   // live futures from a TradingView alert: POST /ingest, GET /tv
import { finvizProbe, getFinviz } from './finviz.js';   // GET /finviz (Finviz news for the card) and GET /finviz-test (diagnostic probe)
import { fvCalProbe } from './fvcal_probe.js';   // GET /fvcal-test: one read-only look at Finviz's economic calendar page (remove with the route)
import { backoffTtl } from './route.js';   // closed-market back-off (shared with /sectors)
import { rulesFrom, rangeFail, checkJump } from './validate.js';   // price validation: V1 range, V2 jump (plan P8.16)

const ALLOWED = [
  'https://jtradeats.github.io',
  // 'http://localhost:8000',   // uncomment while testing locally
];
const FALLBACK_URL = 'https://raw.githubusercontent.com/jtradeats/jtradeats.github.io/data/market.json';
const USE_DATA_BRANCH = true;        // set to false once the GitHub Action is switched off

const TTL_FAST = 30000;              // yahoo / cboe: reuse a result for 30 s
const TTL_SLOW = 15 * 60000;         // treasury / fred: end-of-day data, no point asking every 30 s
const TTL_BY_SRC = { yahoo: TTL_FAST, cboe: TTL_FAST, fred: TTL_SLOW, treasury: TTL_SLOW };
const NEG_TTL = 60000;               // after a failure, wait 60 s before asking that item again
const FNG_TTL = 10 * 60000;          // CNN Fear & Greed
const FNG_RETRY = 2 * 60000;
const SRC_TIMEOUT = 4000;            // per upstream request
const DEADLINE_MS = 5000;            // never make the page wait longer than this for a build
const STALE_OK = 5 * 60000;          // a cached response up to this old is served at once while a refresh runs
const KV_GAP = 3 * 60000;            // KV allows 1,000 writes/day: at most one snapshot write per 3 min
const MIN_FRESH = 5000;              // ?fresh=1 (a manual refresh on the page, P8.11) rebuilds the tape at most this often; the calendar every 3 s, the curve every 30 s
const isFresh = u => { const v = new URL(u).searchParams.get('fresh'); return v !== null && v !== '0' && v !== 'false'; };   // ?fresh=1, ?fresh and ?fresh=true all count; ?fresh=0 does not
const KV_KEY = 'market:snapshot';
const ROLL_MS = 24 * 3600e3;         // how long an item keeps its "rolled" flag
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function get(url, headers = {}, timeout = SRC_TIMEOUT) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.text();
}

function quote(price, prev, t) {
  price = Number(price);
  const out = { p: +price.toFixed(4), t: t ?? null };
  if (prev != null && Number(prev) !== 0) {
    prev = Number(prev);
    out.c = +(price - prev).toFixed(4);
    out.pc = +(((price - prev) / prev) * 100).toFixed(3);
  }
  return out;
}

async function qYahoo(sym) {
  let err;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      const meta = JSON.parse(await get(url)).chart.result[0].meta;
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      const t = meta.regularMarketTime;
      const out = quote(meta.regularMarketPrice, prev, t ? t * 1000 : null);
      const name = meta.shortName || meta.longName;   // resolved contract, e.g. "E-Mini S&P 500 Dec 26"
      if (name) out.contract = String(name).slice(0, 60);
      return out;
    } catch (e) { err = e; }
  }
  throw err;
}

async function qCboe(sym) {
  const d = JSON.parse(await get(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`)).data;
  const price = Number(d.current_price);
  if (!price) throw new Error('zero price');
  let change = d.price_change;
  const pct = d.price_change_percent, prev = d.prev_day_close;
  if ((change == null || Number(change) === 0) && prev != null && Number(prev) !== 0 && Number(prev) !== price) {
    change = price - Number(prev);
  }
  // last_trade_time (New York wall clock) is best-effort; if it is missing the page shows "no timestamp"
  const lt = etToMs(d.last_trade_time);
  const out = { p: +price.toFixed(4), t: lt && lt < Date.now() + 300000 ? lt : null };
  if (change != null) {
    out.c = +Number(change).toFixed(4);
    const base = price - Number(change);
    out.pc = pct != null && pct !== '' ? +Number(pct).toFixed(3) : (base ? +((Number(change) / base) * 100).toFixed(3) : 0);
  }
  return out;
}

let fredKey = null;   // the secret FRED_KEY, copied from env when a tape build starts (getItem has no env); null = use the keyless CSV
async function qFred(series) {
  // cosd limits the CSV to recent rows; the full history is ~17k rows and would blow the CPU limit
  const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  let vals;
  if (fredKey) {   // FRED's API: the keyless CSV is refused from Cloudflare (HTTP 520), the API is not
    vals = [...parseFredJson(await fredApiGet(fredApiUrl(series, fredKey, since)))].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  } else {
    const text = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${since}`);
    vals = text.trim().split(/\r?\n/).slice(1).map(l => l.split(','))
      .filter(r => r.length > 1 && r[1].trim() !== '' && r[1].trim() !== '.')
      .map(r => [r[0], Number(r[1])]);
  }
  if (vals.length < 2) throw new Error(`FRED ${series}: fewer than 2 observations`);
  const [d1, v1] = vals[vals.length - 1];
  const v0 = vals[vals.length - 2][1];
  return quote(v1, v0, Date.parse(d1 + 'T00:00:00Z'));
}

async function loadTreasury(year) {
  const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/' +
    `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  return parseTreasuryCsv(await get(url));   // same row objects as before (keyed by the CSV header), parsed in curve.js so /curve and the tape share one parser
}

// One download per year per 15 min, shared by every item that needs it
const trCache = new Map();
function treasuryRows(year, force) {   // force: a manual refresh (?fresh=1) of /curve skips the 15-minute copy of this year's file
  const c = trCache.get(year);
  if (!force && c && Date.now() - c.at < TTL_SLOW) return c.p;
  const p = loadTreasury(year);
  trCache.set(year, { at: Date.now(), p });
  p.catch(() => trCache.delete(year));
  return p;
}

async function qTreasury(col) {
  const y = new Date().getUTCFullYear();
  const rows = await treasuryRows(y);
  const pick = rs => rs.filter(r => r[col] && r[col] !== 'N/A').map(r => [r.Date, Number(r[col])]);
  let vals = pick(rows);
  if (vals.length < 2) vals = pick([...(await treasuryRows(y - 1)), ...rows]); // early January
  const ts = s => { const [m, d, yy] = s.split('/'); return Date.UTC(+yy, +m - 1, +d); };
  vals.sort((a, b) => ts(a[0]) - ts(b[0]));
  const v0 = vals[vals.length - 2][1];
  const [d1, v1] = vals[vals.length - 1];
  return quote(v1, v0, ts(d1));
}

// ---- yield curve (plan P6): GET /curve. Official Treasury close, computed from the CSV the tape already downloads (shared 15 min cache),
// cross-checked against FRED's T10Y2Y. The result is cached in memory and in KV (written only when a new trading date arrives: about 1 write a day),
// so a request never parses the CSV: it gets the cached answer at once and a refresh runs in the background when it is older than 15 min. ----
const CURVE_KV = 'curve:last';
const CURVE_TTL = 15 * 60000;
const curve = { memo: null, seeded: false, inflight: null, kvAsof: null, err: null, errAt: 0 };
async function buildCurveNow(env, fresh) {
  const y = new Date().getUTCFullYear();
  const since = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  const [cur, prev, fred] = await Promise.allSettled([
    treasuryRows(y, fresh), treasuryRows(y - 1),
    // cross-check series: FRED's API when the secret FRED_KEY is set (the keyless CSV is refused from Cloudflare), the CSV otherwise
    env && env.FRED_KEY ? fredApiGet(fredApiUrl('T10Y2Y', env.FRED_KEY, since)).then(parseFredJson) : get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=T10Y2Y&cosd=${since}`).then(parseFredCsv),
  ]);
  if (cur.status !== 'fulfilled') throw new Error(`Treasury CSV: ${cur.reason && cur.reason.message}`);
  const rows = [...(prev.status === 'fulfilled' ? prev.value : []), ...cur.value];
  const out = buildCurve(rows, fred.status === 'fulfilled' ? fred.value : null);
  out.updated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (prev.status !== 'fulfilled') out.partial = 'last year\'s file was not reached: the 12-month change may be missing';
  const body = JSON.stringify(out);
  curve.memo = { at: Date.now(), body, asof: out.asof, check: out.check.status };
  if (env && env.MARKET_KV && out.asof !== curve.kvAsof) {
    curve.kvAsof = out.asof;
    try { await env.MARKET_KV.put(CURVE_KV, body); } catch (_) { /* ignore */ }
  }
  return body;
}
function refreshCurve(env, fresh) {
  if (!curve.inflight) {
    curve.inflight = buildCurveNow(env, fresh)
      .then(b => { curve.err = null; return b; })
      .catch(e => { curve.err = String(e.message).slice(0, 160); curve.errAt = Date.now(); throw e; })
      .finally(() => { curve.inflight = null; });
  }
  return curve.inflight;
}
async function curveSeed(env) {   // the last saved curve, so a cold isolate (and /health) knows it; its age is unknown here, so at stays 0 and the next request refreshes it
  if (curve.seeded) return;
  curve.seeded = true;
  if (env && env.MARKET_KV) {
    try { const s = await env.MARKET_KV.get(CURVE_KV, 'json'); if (s && s.asof) { curve.memo = { at: 0, body: JSON.stringify(s), asof: s.asof, check: s.check && s.check.status, updated: s.updated }; curve.kvAsof = s.asof; } } catch (_) { /* no KV */ }
  }
}
const CURVE_MIN_FRESH = 30000;
async function getCurve(env, ctx, opts = {}) {
  await curveSeed(env);
  const age = curve.memo ? Date.now() - curve.memo.at : Infinity, fresh = !!opts.fresh && age >= CURVE_MIN_FRESH;   // ?fresh=1 skips the 15-minute reuse (at most every 30 s: parsing the Treasury CSV costs CPU)
  if (curve.memo && !fresh && age < CURVE_TTL) return curve.memo.body;
  if (curve.memo && Date.now() - curve.errAt < NEG_TTL && curve.err) return curve.memo.body;   // the last refresh failed: do not hammer Treasury
  const p = refreshCurve(env, fresh);
  if (fresh && curve.memo) { try { return await p; } catch (e) { return curve.memo.body; } }   // a manual refresh waits for the new answer; a failed one keeps the old
  if (curve.memo) { if (ctx) ctx.waitUntil(p.catch(() => {})); return curve.memo.body; }     // stale-while-revalidate
  return p;
}

const SOURCES = { yahoo: qYahoo, cboe: qCboe, fred: qFred, treasury: qTreasury };

// [label, kind, [[source, symbol], ...] tried in order]. USD20Y dropped (decision D2).
// dashboard_data.py only knows the original 13 items; it is not extended (Action retires in plan 2.3).
const MAIN = SYMBOLS.items.filter(i => !i.set || i.set === 'main');   // items with "set": "sectors" or "weekly" belong to /sectors and /weekly, not to the tape
const ITEMS = MAIN.map(i => [i.label, i.kind, i.chain]);   // source of truth: worker/config/symbols.json
const META = Object.fromEntries(MAIN.map(i => [i.label, { grp: i.group, row: i.row }]));   // tape placement, passed to the page
const TV_LABELS = new Map(SYMBOLS.items.filter(i => i.tv || ((!i.set || i.set === 'main') && i.kind === 'fut')).map(i => [i.label, i.kind]));   // label -> kind of everything the TradingView push may supply: the tape futures and the items flagged "tv" in symbols.json (never VIX or VIXEQ: TradingView shows them delayed)
const TV_WEEKLY = Object.fromEntries(SYMBOLS.items.filter(i => i.set === 'weekly' && i.roll).map(i => [i.label, i.roll]));   // weekly label -> the tape label whose pushed price and week open it uses   // the tape futures a TradingView push may carry (src/tv.js)

const RULES = rulesFrom(SYMBOLS.items);   // label -> { label, kind, range, move } for every item that has a "range" or "move" in symbols.json (plan P8.16)
const RANGES = Object.fromEntries(Object.values(RULES).filter(r => r.range).map(r => [r.label, r.range]));   // the TradingView push applies the same V1 ranges at ingest

function fixYield(q) {
  if (q.p > 25) for (const k of ['p', 'c']) if (k in q) q[k] = +(q[k] / 10).toFixed(4); // x10 quirk
  delete q.pc; // % change of a yield isn't meaningful; the page shows the point change
  return q;
}

// ---- per-item cache: last good value + when it was fetched + how long it stays fresh ----
const itemCache = new Map(); // label -> { val, at, ttl, failAt }
const sectors = makeSectors(SYMBOLS.items);
const weekly = makeWeekly({ items: SYMBOLS.items, marketRoll: label => ((itemCache.get(label) || {}).val || {}).rolledAt || null });   // a roll the tape saw after the Sunday reopen voids that future's week open (R54)

async function getItem(label, kind, chain, log, notes) {
  const c = itemCache.get(label) || {};
  const now = Date.now();
  if (c.val && now - c.at < c.ttl) return;                              // still fresh for its tier
  if (c.val && c.failAt && now - c.failAt < NEG_TTL) return;            // failed a moment ago, don't hammer
  let why;   // set when the last refusal was V1: the tile says why it shows the last good value
  for (const [src, sym] of chain) {
    try {
      let got = await SOURCES[src](sym);
      if (kind === 'yield') got = fixYield(got);
      if (!Number.isFinite(got.p)) throw new Error('bad price');
      const bad = rangeFail(RULES[label], got.p);   // V1 (P8.16): outside the item's range counts as a failed source, so the next one in the chain is tried
      if (bad) throw bad;
      got = { label, kind, src: `${src}:${sym}`, f: Date.now(), ...got };
      const jv = checkJump({ ...RULES[label], kind }, got, c.val, got.f);   // V2 (P8.16): a big move is shown, tagged UNVERIFIED, until the next fetch agrees
      if (jv.unv) { got.unv = true; got.why = jv.why; }
      if (src === 'treasury' || src === 'fred') got.cls = 'prior';      // end-of-day value
      const prior = c.val;
      if (got.contract) {                                               // roll detection
        if (prior && prior.contract && prior.contract !== got.contract) {
          got.rolledAt = Date.now();
          notes.push(`${label} contract changed: ${prior.contract} -> ${got.contract}`);
        } else if (prior && prior.rolledAt && Date.now() - prior.rolledAt < ROLL_MS) got.rolledAt = prior.rolledAt;
      }
      // a cash-market quote frozen at the close is reused for 5 min instead of 30 s; futures, FX and DXY (they trade around the clock) and the 15-minute sources keep their own times
      const base = TTL_BY_SRC[src], ttl = src === 'yahoo' || src === 'cboe' ? backoffTtl({ kind, label }, got.t, Date.now(), base) : base;
      itemCache.set(label, { val: got, at: Date.now(), ttl });
      return;
    } catch (e) { log.push(`${label} ${src}:${sym} failed: ${e.message}`.slice(0, 200)); why = e.range ? e.message : undefined; }
  }
  itemCache.set(label, { ...c, failAt: Date.now(), why });
}
// what /health shows about validation: items whose latest fetch was refused by V1, and items currently tagged UNVERIFIED by V2
function valHealth() {
  const rejected = [], unverified = [];
  for (const [label, c] of itemCache) {
    if (c.why) rejected.push({ label, why: c.why });
    if (c.val && c.val.unv) unverified.push({ label, p: c.val.p, why: c.val.why });
  }
  return { rules: Object.keys(RULES).length, rejected, unverified };
}

// ---- Fear & Greed (CNN) ----
const CNN = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const CNN_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://edition.cnn.com',
  Referer: 'https://edition.cnn.com/markets/fear-and-greed',
};

async function fearGreed() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const attempts = [[`${CNN}/${since}`, CNN_HEADERS], [CNN, CNN_HEADERS], [CNN, {}]];   // the dated form first: same fear_and_greed block, a much smaller body to parse; the bare URL stays as the fallback
  const errs = [];
  const num = v => (v == null ? null : +Number(v).toFixed(1));
  for (const [url, hdr] of attempts) {
    try {
      const f = JSON.parse(await get(url, hdr)).fear_and_greed;
      return { score: num(f.score), prev: num(f.previous_close), week: num(f.previous_1_week),
        month: num(f.previous_1_month), year: num(f.previous_1_year), t: f.timestamp ?? null };
    } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.join(' | '));
}

const fngState = { val: null, at: 0, failAt: 0, err: null };
async function getFng() {
  const now = Date.now();
  if (fngState.val && now - fngState.at < FNG_TTL) return;
  if (fngState.failAt && now - fngState.failAt < FNG_RETRY) return;
  try {
    fngState.val = await fearGreed();
    fngState.at = Date.now(); fngState.failAt = 0; fngState.err = null;
  } catch (e) {
    fngState.failAt = Date.now(); fngState.err = String(e.message).slice(0, 200);
  }
}

// ---- economic calendar ----
// The schedule (worker/config/schedule.json: official release dates and times) is the calendar and never depends on the network.
// Numbers come from these layers, lowest priority first (Financial Modeling Prep was removed on 24 Nov, plan P8.14: its free plan was rejected, HTTP 402, and nothing depended on it):
//   1. Fair Economy / Forex Factory weekly feeds: forecast and previous, no actuals, rate-limits shared Cloudflare IPs (HTTP 429). No key.
//   2. worker/config/results.json: numbers typed in by hand. PLACEHOLDERS: they fill only what no real source has supplied, and the wire and FRED replace them.
//   On top of both: the FinancialJuice wire (blanks only) and the official FRED and EIA series.
// A failure in any layer leaves the schedule untouched and only changes the status fields.
const CAL_FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
// Refresh times live in src/feedpoll.js: both files every 30 min in quiet hours; around a release (10 min before to 45 min after) only this week's file, every 5 min.
const CAL_USE_MAX = 12 * 3600e3;     // never lay a feed copy older than this over the schedule
const CAL_WAIT = 1200;               // a first request waits at most this long for the providers, then answers without them
// The calendar the page gets: from the first day of last month to the last day of next month (the page's month view steps last month, this month, next month).
// A day of margin each side covers the New York / UTC difference; the page filters by New York date.
const calWindow = now => { const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth(); return [Date.UTC(y, m - 1, 1) - 864e5, Date.UTC(y, m + 2, 1) + 864e5]; };
const CAL_KEY = 'calendar:last';
const feedState = { events: null, at: 0, failAt: 0, err: null, status: 'none', inflight: null };

async function loadFeed(urls = CAL_FEEDS) {
  const notes = [], raw = [];
  let ok = 0, rate = false;
  await Promise.all(urls.map(async u => {
    try { raw.push(...JSON.parse(await get(u, { Accept: 'application/json' }))); ok++; }
    catch (e) { if (/HTTP 429/.test(e.message)) rate = true; notes.push(`${u.split('/').pop()}: ${e.message}`); }   // next week's file may not exist yet
  }));
  if (!ok) { const err = new Error(notes.join(' | ')); err.rate = rate; throw err; }
  return { events: normFair(raw, INDICATORS), notes };   // INDICATORS: Forex Factory rates Crude Oil Inventories "Low"; normFair keeps a Low row only when it matches a row of a release the dashboard shows, so the crude forecast arrives
}

// The shared Fair Economy copy in KV, taken over when it is newer than the one in memory (also read by /health, so a cold isolate reports what the poller holds).
async function feedFromKv(env) {
  if (!(env && env.MARKET_KV)) return;
  try {
    const sn = await env.MARKET_KV.get(CAL_KEY, 'json');
    if (sn && sn.events && sn.at > feedState.at) { feedState.events = sn.events; feedState.at = sn.at; feedState.status = 'ok'; }
  } catch (e) { /* KV unavailable: carry on */ }
}
// Bring the Fair Economy copy up to date if it is due. Never throws; records the outcome in feedState.
async function refreshFeed(env, hot = false) {
  const now = Date.now(), ttl = ffTtl(hot);
  if (feedState.events && now - feedState.at < ttl) return;
  // every isolate would otherwise ask the feed on its own, so share one good copy through KV
  if (env && env.MARKET_KV) {
    await feedFromKv(env);
    if (feedState.events && Date.now() - feedState.at < ttl) return;
  }
  if (feedState.failAt && now - feedState.failAt < ffRetry(feedState.rate, hot)) return;
  // A failure is shared like a success: every isolate used to find out about a 429 for itself (about 240 refused calls a day), so the last failures are kept in D1
  // (poll_meta, through beat) and all isolates back off together. ff_429 = last HTTP 429, ff_err = last other failure.
  const fb = env && env.DB ? await beats(env).catch(() => null) : null;
  if (fb) {
    const r429 = fb.ff_429 && now - fb.ff_429 < ffRetry(true, hot), rerr = fb.ff_err && now - fb.ff_err < ffRetry(false, hot);
    if (r429 || rerr) {
      feedState.failAt = r429 ? fb.ff_429 : fb.ff_err; feedState.rate = !!r429;
      if (!feedState.events) feedState.status = r429 ? 'rate-limited' : 'unavailable';
      return;
    }
  }
  try {
    const f = await loadFeed(hot ? CAL_FEEDS.slice(0, 1) : CAL_FEEDS);   // a release window asks for this week's file only: the 429 limit is per file and per address
    if (hot) f.events = mergeFeed(feedState.events, f.events);          // next week's events from the last full poll stay
    feedState.events = f.events; feedState.at = Date.now(); feedState.failAt = 0; feedState.err = null; feedState.rate = false; feedState.status = 'ok';
    // The shared copy is written on every successful poll, so other isolates see a fresh `at` and do not ask Forex Factory themselves (each extra ask risks a 429).
    // Cost: about 100 writes a day (30-minute polls in quiet hours, 5-minute polls in release windows) of the 1,000 free ones.
    if (env && env.MARKET_KV) { try { await env.MARKET_KV.put(CAL_KEY, JSON.stringify({ at: feedState.at, events: f.events })); } catch (e) { /* ignore */ } }
  } catch (e) {
    feedState.failAt = Date.now(); feedState.err = String(e.message).slice(0, 200); feedState.rate = !!e.rate;
    feedState.status = e.rate ? 'rate-limited' : 'unavailable';
    if (env && env.DB) { try { await beat(env, e.rate ? 'ff_429' : 'ff_err', feedState.failAt); } catch (x) { /* ignore: the in-memory back-off still applies */ } }
  }
}
function feedRefresh(env, ctx, hot) {
  if (!feedState.inflight) {
    feedState.inflight = refreshFeed(env, hot).finally(() => { feedState.inflight = null; });
    if (ctx) ctx.waitUntil(feedState.inflight);
  }
  return feedState.inflight;
}

// ---- official actuals (plan 3.5): the release numbers computed from FRED series (see SPEC in official.js for which rows) ----
// With the secret FRED_KEY (free key, the same one the BLS-date fallback uses) the series come from FRED's API. Without it they come from the keyless graph CSV,
// which FRED refuses from Cloudflare's addresses (HTTP 520 on 16 Nov), so the key is what makes this work.
// Polls every 30 min, and every 60 s from 2 min before a release it covers to 90 min after it, so the actual lands as soon as FRED has it.
// FRED's lag behind BLS and DOL is unmeasured: check /calendar?debug=1 on the first release. Memory only (no KV): one request per series (17 for a full poll).
const OFF_SLOW = 3 * 3600e3, OFF_FAST = 60000, OFF_RETRY = 3 * 60000;   // the full 17-series download every 3 h (was 30 min): a finished release does not change, and a release window has its own 60 s tier below
const offState = { M: null, V: {}, at: 0, fastAt: 0, failAt: 0, err: null, status: 'none', inflight: null, via: null };
const redact = s => String(s).replace(/api_key=[^&\s]*/gi, 'api_key=***');
// The official download used to live in isolate memory only, so every cold start began with no official number until the 17 requests finished (longer than the 1.2 s a page waits):
// released rows showed blank actuals ("official: none" in /calendar?debug=1). Now the recent part of every series is kept in one KV key and read back on a cold start.
// Written when the data changes, and at least every 2.5 h so the copy never looks older than the 12 h limit while nothing changes (about 10 writes a day).
const OFF_KV = 'calendar:official', OFF_KEEP = 80, OFF_REWRITE = 150 * 60000;
const offKv = { seeded: false, sig: null, savedAt: 0 };
async function offSeed(env) {
  if (offKv.seeded || offState.M || !(env && env.MARKET_KV)) return;
  offKv.seeded = true;
  try {
    const j = await env.MARKET_KV.get(OFF_KV, 'json');
    if (!j || j.v !== 1 || !j.M || !j.at) return;
    const rev = o => Object.fromEntries(Object.entries(o || {}).map(([s, a]) => [s, new Map(a)]));
    offState.M = rev(j.M); offState.V = rev(j.V); offState.at = j.at; offState.status = 'ok'; offState.via = (j.via || 'api') + ' (kv copy)'; offKv.savedAt = j.saved || j.at; offKv.sig = j.sig || null;
  } catch (_) { /* a cold start without the copy is what it was before */ }
}
async function offSave(env, now) {
  if (!(env && env.MARKET_KV) || !offState.M) return;
  const cut = o => Object.fromEntries(Object.entries(o || {}).map(([s, m]) => [s, [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-OFF_KEEP)]));
  const M = cut(offState.M), V = cut(offState.V), sig = JSON.stringify([M, V]);
  if (sig === offKv.sig && now - offKv.savedAt < OFF_REWRITE) return;
  try { await env.MARKET_KV.put(OFF_KV, JSON.stringify({ v: 1, at: offState.at, saved: now, via: offState.via, sig, M, V })); offKv.sig = sig; offKv.savedAt = now; } catch (_) { /* tried again at the next refresh */ }
}
// The API call says who it is (FRED's terms ask programs to identify themselves) and, when it fails, keeps what FRED answered: status, server and the start of the body.
// A 520 from a plain `get` tells nothing; the body and headers show whether it is a block, a bad key or an outage.
// One retry after 800 ms for the statuses that clear on their own (a burst of 403/429 from FRED's edge, 5xx). The error says when the retry was spent, so a failure that survived it is visible as such.
async function fredApiGet(url, retry = true, tried = false) {
  const r = await fetch(url, { headers: { 'User-Agent': 'market-dashboard/1.0 (personal dashboard; +https://jtradeats.github.io)', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  const text = await r.text();
  if (!r.ok) {
    if (retry && [403, 429, 502, 503, 520, 522].includes(r.status)) { await new Promise(x => setTimeout(x, 800)); return fredApiGet(url, false, true); }
    const snip = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`HTTP ${r.status}${tried ? ' (after retry)' : ''} from ${new URL(url).host} [server=${r.headers.get('server') || '?'}${r.headers.get('cf-ray') ? ' cf-ray=' + r.headers.get('cf-ray') : ''}] ${snip}`);
  }
  return text;
}
// `only`: a Set of series to fetch (the ones a release in the next minutes needs); omitted = every series. A partial fetch is merged into what is held.
async function loadOfficial(env, only) {
  const since = new Date(Date.now() - 460 * 864e5).toISOString().slice(0, 10);   // 13+ months: year-on-year needs it
  const key = env && env.FRED_KEY, M = {}, V = {}, errs = [];
  // P8.18: for a series that BEA revises (GDP), also ask when each value began, from 47 days back (the 45-day window of applyOfficial plus a margin), so an unrevised quarter is never read as the new estimate
  const vFrom = new Date(Date.now() - 47 * 864e5).toISOString().slice(0, 10), vSince = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  await Promise.all(OFF_SERIES.filter(s => !only || only.has(s)).map(async s => {
    const vp = key && VINTAGE_SERIES.has(s) ? fredApiGet(fredVintageUrl(s, key, vSince, vFrom)).then(parseFredVintage).then(m => { V[s] = m; }, e => { errs.push([`${s} vintages`, redact(e.message)]); }) : null;
    try {
      if (s.startsWith('EIA:')) {   // P8.33: EIA's own API (secret EIA_KEY); no keyless fallback exists
        if (!(env && env.EIA_KEY)) throw new Error('no EIA_KEY set');
        M[s] = parseEiaJson(await fredApiGet(eiaApiUrl(s.slice(4), env.EIA_KEY, since)));
      } else
      M[s] = key ? parseFredJson(await fredApiGet(fredApiUrl(s, key, since))) : parseFredCsv(await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s}&cosd=${since}`));
      if (!M[s].size) throw new Error('no rows');
    } catch (e) { delete M[s]; errs.push([s, redact(e.message)]); }
    if (vp) await vp;
  }));
  // the same failure for every series is shown once, not once per series
  const text = errs.length > 1 && errs.every(([, m]) => m === errs[0][1]) ? [`${errs.length} series: ${errs[0][1]}`] : errs.map(([s, m]) => `${s}: ${m}`);
  // the per-series list, untruncated, for ?debug=1 (the one-line `text` above is cut to 320 characters and hides which series failed)
  const list = errs.map(([s, m]) => ({ s, e: m }));
  const asked = OFF_SERIES.filter(s => !only || only.has(s)).length;
  if (!Object.keys(M).length) { const err = new Error((key ? '' : 'no FRED_KEY set (the keyless CSV is usually refused): ') + text.join(' | ')); err.list = list; err.asked = asked; throw err; }
  return { M, V, errs: text, list, asked, via: key ? 'api' : 'csv' };
}
// Every series every 30 min; in the window around a release (2 min before to 90 min after) only the series that release needs, every 60 s. That keeps a busy
// minute to a handful of requests (the free plan allows 50 per invocation, and FRED 120 a minute) while the actual still lands within a minute of FRED having it.
async function refreshOfficial(env, sch) {
  const now = Date.now(), nearSer = new Set();
  for (const e of sch.events) { const sp = OFF_SPEC[e.k + '|' + e.r]; if (sp && e.t > now - 90 * 60000 && e.t < now + 120000) nearSer.add(sp.s); }
  if (offState.failAt && now - offState.failAt < OFF_RETRY) return;
  const fullDue = !offState.M || now - offState.at >= OFF_SLOW;
  const fastDue = nearSer.size > 0 && now - Math.max(offState.at, offState.fastAt || 0) >= OFF_FAST;
  if (!fullDue && !fastDue) return;
  try {
    const o = await loadOfficial(env, fullDue ? null : nearSer);
    if (fullDue) { offState.M = o.M; offState.V = o.V; offState.at = Date.now(); } else { offState.M = { ...offState.M, ...o.M }; offState.V = { ...offState.V, ...o.V }; offState.fastAt = Date.now(); }
    offState.failAt = 0; offState.err = o.errs.length ? o.errs.join(' | ').slice(0, 320) : null; offState.status = 'ok'; offState.via = o.via;
    // per-series errors: a full run replaces the list; a quick run replaces only the series it asked for, so an older failure on another series stays visible
    const fetched = fullDue ? null : nearSer;
    offState.errList = (fullDue ? [] : (offState.errList || []).filter(x => !fetched.has(String(x.s).replace(/ vintages$/, '')))).concat(o.list.map(x => ({ ...x, at: Date.now() })));
    offState.lastRun = { at: Date.now(), kind: fullDue ? 'full' : 'quick', asked: o.asked, failed: o.list.length };
    await offSave(env, Date.now());
    if (fullDue && env && env.DB) await beat(env, 'off_ok', offState.at);   // a stored mark of the last full download (the data itself is memory only), so /health can say it on a cold read
  } catch (e) {
    offState.failAt = Date.now(); offState.err = redact(e.message).slice(0, 320);
    offState.errList = (e.list && e.list.length ? e.list : [{ s: '*', e: redact(e.message) }]).map(x => ({ ...x, at: Date.now() }));
    offState.lastRun = { at: Date.now(), kind: fullDue ? 'full' : 'quick', asked: e.asked || null, failed: e.asked || null, threw: true };
    if (fullDue) offState.status = 'unavailable';   // a failed quick refresh keeps the 30-minute copy and its status
  }
}
function offRefresh(env, ctx, sch) {
  if (!offState.inflight) {
    offState.inflight = refreshOfficial(env, sch).finally(() => { offState.inflight = null; });
    if (ctx) ctx.waitUntil(offState.inflight);
  }
  return offState.inflight;
}

// The expanded schedule and its audit are cheap but not free (10 ms CPU limit): keep them for a while
// kinds without the provider-title patterns (those are only for the Worker's matching)
const KINDS_PUBLIC = Object.fromEntries(Object.entries(INDICATORS.kinds).map(([k, v]) => {
  const { match, rows, ...rest } = v;
  return [k, { ...rest, rows: (rows || []).map(({ match: m, ...r }) => r) }];
}));
// ---- schedule sync (plan P2 and P3, D76 to D96) ----
// schedule.json is the baseline. What the nightly sync found is kept in KV ("schedule:synced") and merged over it on every load (schedule_sync.js, mergeSchedule),
// so a failed run changes nothing. Three daily Cron Triggers, one per source, so each run has its own 10 ms CPU budget (the strings must match wrangler.toml):
//   bls = the BLS release pages (CPI, jobs report, PPI, JOLTS), treasury = TreasuryDirect plus Treasury's tentative auction schedule, provider = the calendar feeds' look-ahead.
// Lazy safety net (D77): a source that is overdue (never run, or not refreshed for 36 h) is started in the background by the next /calendar request, one source at a time.
// GET /sync shows the state (read only; no way to start a run from outside).
async function pollerHealth(env) {
  const [b, p] = await Promise.all([beats(env), postsSummary(env)]), now = Date.now(), age = k => (b && b[k] ? Math.round((now - b[k]) / 1000) : null);
  return { d1: !!(env && env.DB), feeds_run_age_s: age('feeds_run'), feeds_ok_age_s: age('feeds_ok'), calendar_age_s: age('cal'), calendar_near_age_s: age('cal_near'), policy_ok_age_s: age('policy_ok'), official_ok_age_s: age('off_ok'), feed_429_age_s: age('ff_429'), feed_err_age_s: age('ff_err'), posts: p, error: postsError() };
}
const SYNC_CRONS = { '20 9 * * *': 'bls', '30 9 * * *': 'treasury', '40 9 * * *': 'provider' };
// The background pollers (plan P8.32): nothing may depend on a page being open. Two more triggers, each its own invocation and so its own 10 ms CPU budget.
//   every minute:    both Telegram wires are read, new posts are stored in D1, a hole left by a long pause is closed (feed.js); once an hour old rows are pruned
//   every 2 minutes: the calendar is built as a page would build it (calendar feeds, FRED, the wire's numbers, the ledger), every 2 minutes from 3 minutes before
//                    a release until 90 minutes after it and every 10 minutes otherwise, so an actual is captured and stored with nobody watching
// The strings must match wrangler.toml.
const POLL_FEEDS = '* * * * *', POLL_CAL = '*/2 * * * *';
const CAL_NEAR = [3 * 60000, 90 * 60000];   // a release is "near" from 3 minutes before to 90 minutes after (the official series' own fast tier is 2 to 90)
async function pollFeeds(env, ctx, at) {
  const body = JSON.parse(await getFeeds(env, ctx, {}));
  const ok = [body, body.fj].some(v => v && v.status === 'ok');
  const now = Date.now(), min = Math.floor(at / 60000);
  if (min % 5 === 0) {   // a heartbeat every 5 minutes: 288 rows a day for each of the two, not 1,440
    await beat(env, 'feeds_run', now);
    if (ok) await beat(env, 'feeds_ok', now);
  }
  if (min % 60 === 0) await Promise.all(Object.keys(CHANNELS).map(n => prunePosts(env, n)));
  await pushNew(env, async () => applySettings((await getAlerts(env, ctx, { cal: false })).list, await loadSettings(env)), now);   // phone alerts for the new posts (nothing happens when nobody is subscribed); the control center's master switch applies first
}
async function pollCalendar(env, ctx, at) {
  await loadSync(env);
  const sch = schedule(at), min = Math.floor(at / 60000);
  const near = sch.events.some(e => e && !e.hol && e.src !== 'feed' && Number.isFinite(e.t) && e.t <= at + CAL_NEAR[0] && e.t >= at - CAL_NEAR[1]);
  // a ticked reminder (any of the times in alerts.js REM_MENU) that has not been pushed yet makes a quiet tick build the calendar, because the reminder quotes the forecast
  const due = !near && min % 10 !== 0 && (await loadPrefs(env)).kinds.remind && remindWanted(await loadSettings(env)) ? reminderIdsDue(sch.events, at, wantedMins(await loadSettings(env))) : [];   // reminders switched off for the phone (stage 4): nothing to wait for
  if (!near && min % 10 !== 0 && !(due.length && await anyUnsent(env, due))) { await policyDaily(env, sch, at); return; }   // a quiet tick: the policy facts' daily run uses its own CPU
  await getCalendar(env, ctx, {});
  await beat(env, near ? 'cal_near' : 'cal', Date.now());
  await pushNew(env, async () => applySettings((await getAlerts(env, ctx, { wire: false })).list, await loadSettings(env)), Date.now());   // reminders, release alerts and corrections; the control center's master switch and reminder choices apply first
}
const SYNC_RELOAD = 5 * 60000, LAZY_GAP = 10 * 60000, LAZY_GAP_NEVER = 60000, SYNC_TIMEOUT = 8000;
const SYNC_TIMEOUT_TREASURY = 25000;   // TreasuryDirect's "announced" lookups (the only treasurydirect.gov calls) timed out at 8 s and again at 15 s. runTreasury runs them beside the tentative-file reads, so a run is about 25 s at worst: inside the 30 s a background (waitUntil) run is allowed
const syncState = { rec: null, at: 0, running: false, tried: {}, last: null };
const etD = ms => { const q = etParts(ms); return q.iso + ' ' + q.hm; };   // 'YYYY-MM-DD HH:MM' in New York, for the debug lists
const nyDate = ms => etParts(ms).iso;   // YYYY-MM-DD in New York (date arithmetic, P8.15: toLocaleDateString built a new Intl formatter on every call)

async function loadSync(env, force) {
  const now = Date.now();
  if (!force && syncState.at && now - syncState.at < SYNC_RELOAD) return syncState.rec;
  syncState.at = now;
  if (env && env.MARKET_KV) {
    try { const r = await env.MARKET_KV.get(SYNC_KEY, 'json'); if (r && r.src && (!syncState.rec || r.at >= syncState.rec.at)) syncState.rec = r; } catch (e) { /* KV unavailable: carry on with what is in memory */ }
  }
  return syncState.rec;
}

// Fair Economy (two weeks). A provider that fails is reported, never thrown. (FMP was a second provider until 24 Nov, plan P8.14.)
async function gatherProvider(env) {
  const feeds = [], clean = e => String(e.message).replace(/apikey=[^&\s]*/gi, 'apikey=***').slice(0, 100);
  try {   // the calendar's shared copy (memory, then KV, with its own 429 back-off): the sync never makes a second direct ask of Fair Economy, which is what kept hitting HTTP 429
    await refreshFeed(env);
    if (!feedState.events || Date.now() - feedState.at > CAL_USE_MAX) throw new Error(feedState.err || 'no recent Fair Economy copy');
    feeds.push({ name: 'Fair Economy', rows: feedState.events });
  } catch (e) { feeds.push({ name: 'Fair Economy', rows: [], err: clean(e) }); }
  return feeds;
}

async function runSyncSource(name, env) {
  const now = Date.now(), today = nyDate(now);
  const old = (await loadSync(env, true)) || { v: 1, at: 0, src: {}, changes: [] };
  const prev = old.src[name] || null;
  let out;
  try {
    if (name === 'bls') {
      // bls.gov answered 403 to the browser-style User-Agent (15 Nov). BLS asks automated clients to say who they are, so when BLS_CONTACT (an e-mail) is set it is sent in the User-Agent.
      const h = env && env.BLS_CONTACT ? { 'User-Agent': `market-dashboard/1.0 (schedule check; ${env.BLS_CONTACT})`, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } : {};
      out = await runBls({ get: u => get(u, h, SYNC_TIMEOUT), IND: INDICATORS, now, prev });
      // Fallback: where the BLS page could not be read, the dates come from the FRED release calendar (needs the secret FRED_KEY; see runFred).
      const bad = Object.entries(out.k).filter(([, x]) => !(x.ok && x.at === now)).map(([kind]) => kind);
      if (bad.length && env && env.FRED_KEY) {
        const f = await runFred({ get: u => get(u, { Accept: 'application/json' }, SYNC_TIMEOUT), key: env.FRED_KEY, kinds: bad, IND: INDICATORS, base: SCHEDULE.releases, now, prev });
        Object.assign(out.k, f.k);
        out.ok = Object.values(out.k).some(x => x.ok && x.at === now);
        out.err = Object.values(out.k).filter(x => !(x.ok && x.at === now)).length ? [out.err, f.err].filter(Boolean).join(' || ').slice(0, 300) : null;
      }
    }
    else if (name === 'treasury') out = await runTreasury({ IND: INDICATORS, now, prev, get: async u => {
      const td = /treasurydirect\.gov/.test(u), t0 = Date.now();
      try { return await get(u, { Accept: 'application/json, application/xml, text/xml, */*' }, td ? SYNC_TIMEOUT_TREASURY : SYNC_TIMEOUT); }
      catch (e) { if (td) throw new Error(`${e && e.message} (gave up after ${Date.now() - t0} ms)`); throw e; }   // a hang and a quick refusal need different fixes: /sync now says which it was. A NEW error: the runtime's timeout error has a read-only message, and assigning to it hid the real error (18 Nov /sync)
    } });
    else if (name === 'provider') out = runProvider({ feeds: await gatherProvider(env), base: SCHEDULE.releases, IND: INDICATORS, now, prev });
    else return null;
  } catch (e) {
    out = { ...(prev || { k: {} }), at: now, ok: false, err: String(e.message).slice(0, 200) };   // keep the last good lines
  }
  const next = { ...old, v: 1, at: now, src: { ...old.src, [name]: out } };
  let diff = [];
  try { diff = diffSchedules(mergeSchedule(SCHEDULE, old, INDICATORS, today), mergeSchedule(SCHEDULE, next, INDICATORS, today), INDICATORS, today); } catch (e) { /* the change log is a nicety */ }
  next.changes = [...diff.map(c => ({ ...c, at: now, src: name })), ...(old.changes || [])].slice(0, 40);
  syncState.rec = next; syncState.at = now;
  let saved = !!(env && env.MARKET_KV);
  if (saved) { try { await env.MARKET_KV.put(SYNC_KEY, JSON.stringify(next)); } catch (e) { saved = false; } }
  syncState.last = { name, at: now, ok: !!out.ok, err: out.err || null, changes: diff.length, saved };
  return syncState.last;
}

function syncLazy(env, ctx, now) {
  if (syncState.running) return;
  const rec = syncState.rec, due = dueSources(rec, now, false);
  const name = due.find(n => now - (syncState.tried[n] || 0) > (rec && rec.src && rec.src[n] ? LAZY_GAP : LAZY_GAP_NEVER));
  if (!name) return;
  syncState.tried[name] = now; syncState.running = true;
  const p = runSyncSource(name, env).catch(() => {}).finally(() => { syncState.running = false; });
  if (ctx) ctx.waitUntil(p);
}

function syncHealth() {
  const r = syncState.rec, now = Date.now();
  if (!r) return { loaded: false, running: syncState.running };
  return { loaded: true, running: syncState.running, sources: Object.fromEntries(Object.entries(r.src || {}).map(([n, s]) => [n, { ok: !!s.ok, age_s: s.at ? Math.round((now - s.at) / 1000) : null, error: s.err ? String(s.err).slice(0, 80) : null }])) };
}

// The effective schedule = schedule.json + the sync overlay. Rebuilt when the overlay changes or the New York date turns; the audit (about 3 ms) never runs in the
// same request as a rebuild unless it is the very first one, so a cold start stays well under the CPU limit.
const schedCache = { events: null, aud: null, at: 0, sig: null, day: null, eff: null, merged: null, checked: null, audStale: false };
function schedule(now) {
  const sig = syncState.rec ? syncState.rec.at : 0, day = nyDate(now);
  let rebuilt = false;
  if (!schedCache.events || schedCache.sig !== sig || schedCache.day !== day) {
    const m = mergeSchedule(SCHEDULE, syncState.rec, INDICATORS, day);
    const have = new Set(m.releases.map(r => r.k + '|' + r.d + '|' + (r.p || '')));
    const hist = (HISTORY.releases || []).filter(r => !have.has(r.k + '|' + r.d + '|' + (r.p || '')));   // a line the baseline or the sync has wins
    schedCache.eff = { ...SCHEDULE, releases: hist.concat(m.releases), checked: m.checked };
    schedCache.events = expand(schedCache.eff, INDICATORS);
    schedCache.merged = m; schedCache.checked = m.checked; schedCache.sig = sig; schedCache.day = day;
    rebuilt = true; schedCache.audStale = true;
  }
  if (!schedCache.aud || (!rebuilt && (schedCache.audStale || now - schedCache.at > 10 * 60000))) { schedCache.aud = audit(schedCache.eff, INDICATORS, now); schedCache.at = now; schedCache.audStale = false; }
  return schedCache;
}

// ---- FinancialJuice actuals (plan P8.19 stage 2, D117): the wire's first number fills a blank, tagged FJ, until FRED or a typed number settles it ----
// The numbers live in a small memo (isolate memory, one KV key written only when it changes, at most every 30 s) so they outlive the 50-post window and a cold start.
const wireSt = { memo: null, seeded: false, dirty: false, lastKv: 0, feed: 'none', err: null };
async function wireSeed(env) {
  if (wireSt.seeded) return;
  wireSt.seeded = true;
  wireSt.memo = newMemo();
  if (!(env && env.MARKET_KV)) return;
  try { const m = await env.MARKET_KV.get(WIRE_KV, 'json'); if (m && m.rows && Array.isArray(m.log)) wireSt.memo = m; } catch (_) { /* carry on without it */ }
}
async function wireSave(env, now) {
  if (!wireSt.dirty || !(env && env.MARKET_KV) || now - wireSt.lastKv < 30000) return;
  wireSt.lastKv = now; wireSt.dirty = false;
  try { await env.MARKET_KV.put(WIRE_KV, JSON.stringify(wireSt.memo)); } catch (_) { wireSt.dirty = true; }
}
// a release the wire covers is due within 2 minutes or happened in the last 40: only then is Telegram polled for the calendar (otherwise the window is read as it is)
// Backfill (P8.39). The window the wire poll returns holds only the newest posts, and posts older than 6 hours were never read again, so a release whose post had
// scrolled out (or whose rule name was fixed after the release) kept an empty forecast or actual, and typed numbers had to cover it. The posts stay in D1 for longer:
// read them back, in the background, at most every BF_GAP, and only while a released row the wire covers is still missing a number. It fills the wire memo (KV), so the
// number outlives this isolate; it never touches the schedule's own event objects (clones are used).
const bfSt = { at: 0, running: false, n: 0, filled: 0, err: null, unmatchedUs: [] };
const BF_GAP = 20 * 60000, BF_LIMIT = 500;
const wireCovered = e => !e.hol && e.src !== 'feed' && WIRE_KEYS.has(e.k + '|' + e.r) && !/^auc/.test(e.k);
function wireBackfill(env, ctx, events, now) {
  if (bfSt.running || now - bfSt.at < BF_GAP) return;
  if (!events.some(e => wireCovered(e) && e.t <= now && e.t > now - 4 * 864e5 && (e.ac == null || e.fc == null || e.pv == null))) return;   // D1 keeps about 800 posts (2-3 days): an older row cannot be helped by reading it
  bfSt.running = true; bfSt.at = now;
  const run = (async () => {
    try {
      const posts = await loadPosts(env, 'FinancialJuice', BF_LIMIT);
      if (!posts || !posts.length) { bfSt.err = 'no posts read from D1'; return; }
      const before = Object.keys(wireSt.memo.rows).length;
      const r = applyWire(events.map(e => ({ ...e, sr: e.sr ? { ...e.sr } : undefined })), posts, Date.now(), wireSt.memo);
      bfSt.n = posts.length; bfSt.err = null; bfSt.filled = Object.keys(wireSt.memo.rows).length - before;
      bfSt.unmatchedUs = unmatchedUsNames(posts);   // 25 Nov: durable goods printed and no rule matched; this shows FinancialJuice's wording for it
      if (r.changed) wireSt.dirty = true;
    } catch (e) { bfSt.err = String(e && e.message).slice(0, 100); }
    finally { bfSt.running = false; }
  })();
  if (ctx) ctx.waitUntil(run);
}
const wireHot = (events, now) => events.some(e => !e.hol && e.src !== 'feed' && WIRE_KEYS.has(e.k + '|' + e.r) && e.t <= now + 120000 && e.t >= now - 40 * 60000);

// ---- first prints (plan P8.23): the "previous" and the first actual each release showed before revisions, so a revised previous can be underlined (green or red) without typed marks ----
const firstSt = { mem: null, seeded: false, dirty: false, lastKv: 0 };
async function firstSeed(env) {
  if (firstSt.seeded) return;
  firstSt.seeded = true;
  firstSt.mem = newFirst();
  if (!(env && env.MARKET_KV)) return;
  try { firstSt.mem = fromKv(await env.MARKET_KV.get(FP_KV, 'json')); } catch (_) { /* carry on without it */ }
}
async function firstSave(env, now) {
  if (!firstSt.dirty || !(env && env.MARKET_KV) || now - firstSt.lastKv < 30000) return;
  firstSt.lastKv = now; firstSt.dirty = false;
  try { await env.MARKET_KV.put(FP_KV, JSON.stringify(firstSt.mem)); } catch (_) { firstSt.dirty = true; }   // an entry is added a few times a day, so this is a handful of the 1,000 free writes
}

// ---- history fill (P8.40): released rows older than 45 days that the ledger holds no official actual for ----
// applyOfficial stops at 45 days (FRED then holds a revised value). For older rows the number the calendar showed is read once from FRED's archive as it stood on the release day
// (official.js, histNumbers), written into the ledger as an official number and never asked for again. EIA stocks are not revised: the current series is used.
// A row that cannot be filled (no key, no value that day) is not retried for 6 hours. At most HIST_PER_RUN requests per run, in the background.
const histSt = { running: false, at: 0, tried: {}, filled: 0, err: null };
const HIST_GAP = 2 * 60000, HIST_PER_RUN = 4, HIST_RETRY = 6 * 3600e3;
function histFill(env, ctx, events, now) {
  if (histSt.running || now - histSt.at < HIST_GAP || !ledgerSt.mem) return;
  const need = [];
  for (const e of events) {
    const sp = OFF_SPEC[e.k + '|' + e.r];
    if (!sp || e.hol || e.src === 'feed' || !e.id || e.t > now - HIST_MIN_AGE || now - (histSt.tried[e.id] || 0) < HIST_RETRY) continue;
    const r = ledgerSt.mem.rows[e.id];
    if (r && r.ac != null && r.ac !== '' && rankOf(r.sa) >= 4) continue;   // already official in the ledger
    need.push({ e, sp });
  }
  if (!need.length) return;
  histSt.running = true; histSt.at = now;
  const run = (async () => {
    const key = env && env.FRED_KEY, cache = new Map();
    let fetched = 0;
    try {
      for (const { e, sp } of need) {
        let S = null, tag = sp.tag || 'FRED';
        if (sp.s.startsWith('EIA:')) { S = offState.M && offState.M[sp.s]; if (!S) continue; }   // the series is not loaded yet: try again at the next run
        else {
          if (!key) { histSt.err = 'no FRED_KEY'; continue; }
          const ck = sp.s + '|' + e.d;
          if (!cache.has(ck)) {
            if (fetched >= HIST_PER_RUN) continue;   // the rest on the next run
            fetched++;
            const since = new Date(Date.parse(e.d + 'T00:00:00Z') - 460 * 864e5).toISOString().slice(0, 10);
            try { cache.set(ck, parseFredJson(await fredApiGet(fredAsOfUrl(sp.s, key, since, e.d)))); } catch (x) { cache.set(ck, null); histSt.err = redact(x.message).slice(0, 160); }
          }
          S = cache.get(ck);
        }
        histSt.tried[e.id] = Date.now();
        const h = S && histNumbers(S, sp, e);
        if (!h) continue;
        const r = ledgerSt.mem.rows[e.id] || (ledgerSt.mem.rows[e.id] = { t: e.t });
        r.ac = h.ac; r.sa = tag; r.at = Date.now();
        if (h.pv != null) { r.pv = h.pv; r.pvc = null; r.sp = tag; }
        ledgerSt.dirty = true; histSt.filled++; histSt.err = null;
      }
    } catch (x) { histSt.err = redact(x && x.message).slice(0, 160); }
    finally { histSt.running = false; }
  })();
  if (ctx) ctx.waitUntil(run);
}

// ---- actuals ledger (plan P8.30): the floor under the live sources, so a lapsed or cold source never drops a row back to the wire's number ----
const ledgerSt = { mem: null, seeded: false, dirty: false, lastKv: 0, restored: 0 };
async function ledgerSeed(env) {
  if (ledgerSt.seeded) return;
  ledgerSt.seeded = true;
  ledgerSt.mem = newLedger();
  if (!(env && env.MARKET_KV)) return;
  try { ledgerSt.mem = ledgerFromKv(await env.MARKET_KV.get(LG_KV, 'json')); } catch (_) { /* carry on without it */ }
}
async function ledgerSave(env, now) {
  if (!ledgerSt.dirty || !(env && env.MARKET_KV) || now - ledgerSt.lastKv < 30000) return;
  ledgerSt.lastKv = now; ledgerSt.dirty = false;
  try { await env.MARKET_KV.put(LG_KV, JSON.stringify(ledgerSt.mem)); } catch (_) { ledgerSt.dirty = true; }   // an entry is added or revised a few times a day
}

// ---- policy facts (plan P8.9): the target range, the last change and decision, built from FRED and the FOMC schedule, no AI and nothing typed by hand ----
// Runs once a day from the 2-minute poller (on a tick that builds nothing else, so it has its own CPU) and, on a decision day, from the first calendar build after the
// decision time (at most every 10 minutes) until FRED's series shows the decision. One KV key, written when the facts change or the day turns (at most 2 a day).
const POLICY_GAP = 10 * 60000, POLICY_DAILY = 23 * 3600e3;
const policySt = { facts: null, vote: null, seeded: false, tryAt: 0, running: false, err: null, kvSig: '', okAt: 0 };
async function policySeed(env) {
  if (policySt.seeded) return;
  policySt.seeded = true;
  if (!(env && env.MARKET_KV)) return;
  try { const r = await env.MARKET_KV.get(POLICY_KV, 'json'); if (r && r.facts) { policySt.facts = r.facts; policySt.vote = r.vote || null; policySt.kvSig = JSON.stringify({ ...r.facts, at: 0 }) + JSON.stringify(r.vote || null); } } catch (_) { /* carry on without it */ }
}
const policyDecs = sch => decisionList(POLICY_CFG, sch.events);
const policyVote = () => (policySt.facts && policySt.facts.decision && policySt.vote && policySt.vote.d === policySt.facts.decision.d ? policySt.vote.v : null);
async function runPolicy(env) {
  const key = env && env.FRED_KEY;
  if (!key) return false;
  const now = Date.now();
  policySt.tryAt = now;
  try {
    const since = new Date(now - 800 * 864e5).toISOString().slice(0, 10);
    const [U, L] = await Promise.all([SERIES_U, SERIES_L].map(sr => fredApiGet(fredApiUrl(sr, key, since)).then(parseFredJson)));
    const f = computeFacts(U, L, policyDecs(schedule(now)), now, nyDate(now));
    if (!f) throw new Error('the target-range series is too short to read');
    // the vote: from the Fed's statement page for the last decision, once the series shows it; a page that cannot be read is tried again later (4 times at most, 6 hours apart), never guessed
    let vt = policySt.vote && f.decision && policySt.vote.d === f.decision.d ? policySt.vote : null;
    if (f.decision && f.decision.reflected && (!vt || (vt.v == null && vt.tries < 4 && now - vt.at > 6 * 3600e3))) {
      let v = null;
      try { v = parseVotes(await get(statementUrl(f.decision.d), { Accept: 'text/html' }, 8000)); } catch (_) { /* the page is not reachable: no vote sentence */ }
      vt = { d: f.decision.d, v, at: now, tries: (vt ? vt.tries : 0) + 1 };
    }
    policySt.facts = f; policySt.vote = vt; policySt.err = null; policySt.okAt = now;
    const sig = JSON.stringify({ ...f, at: 0 }) + JSON.stringify(vt);
    if (sig !== policySt.kvSig && env.MARKET_KV) { await env.MARKET_KV.put(POLICY_KV, JSON.stringify({ facts: f, vote: vt })); policySt.kvSig = sig; }
    return true;
  } catch (e) { policySt.err = redact(e.message).slice(0, 200); return false; }
}
// a decision whose time has passed that the facts do not show yet (and is under 4 days old): refresh now, then every 10 minutes
function policyPending(sch, now) {
  const f = policySt.facts, latest = policyDecs(sch).filter(x => x.t <= now).pop();
  return !f || (latest && now - latest.t < 4 * 864e5 && (!f.decision || f.decision.d < latest.d || !f.decision.reflected));
}
function policyLazy(env, ctx, sch, now) {
  if (!(env && env.FRED_KEY) || policySt.running || now - policySt.tryAt < POLICY_GAP || !policyPending(sch, now)) return;
  policySt.running = true;
  const p = runPolicy(env).finally(() => { policySt.running = false; });
  if (ctx) ctx.waitUntil(p);
}
async function policyDaily(env, sch, at) {
  if (!(env && env.FRED_KEY) || policySt.running) return;
  await policySeed(env);
  const vt = policySt.vote, retry = !!(policySt.facts && policySt.facts.decision && policySt.facts.decision.reflected && (!vt || vt.d !== policySt.facts.decision.d || (vt.v == null && vt.tries < 4 && at - vt.at > 6 * 3600e3)));   // the statement could not be read last time: ask again, 6 hours apart, 4 times at most
  if (policySt.facts && at - policySt.facts.at < POLICY_DAILY && !policyPending(sch, at) && !retry) return;
  const b = await beats(env);
  if (b && b.policy_try && Date.now() - b.policy_try < POLICY_GAP) return;   // another isolate tried a moment ago
  await beat(env, 'policy_try', Date.now());
  policySt.running = true;
  try { if (await runPolicy(env)) await beat(env, 'policy_ok', Date.now()); } finally { policySt.running = false; }
}
function policyHealth(env) {
  const f = policySt.facts, now = Date.now();
  return { key: !!(env && env.FRED_KEY), loaded: !!f, checked: f ? f.checked : null, age_s: f ? Math.round((now - f.at) / 1000) : null, range: f ? `${f.lower.toFixed(2)}-${f.upper.toFixed(2)}%` : null,
    decision: f && f.decision ? f.decision : null, vote: policySt.vote ? (policySt.vote.v ? 'found' : `not found (${policySt.vote.tries} tries)`) : 'not tried', error: policySt.err };
}

// ---- actuals lag log (plan P8.18, O60) ----
const lagSt = { seen: new Set() };
function lagDetect(events, live, now) {
  const out = [];
  for (const e of events) {
    if (e.hol || e.src === 'feed' || !live.has(e.id) || e.t > now || now - e.t > 3 * 36e5 || lagSt.seen.has(e.id)) continue;
    const src = (e.sr && e.sr.ac) || 'feed';
    if (src === 'ref') continue;   // a hand-typed placeholder is not a source
    lagSt.seen.add(e.id);
    out.push({ id: e.id, rel: e.t, seen: now, src });
  }
  return out;
}

let calMemo = null;   // { at, debug, body }: the page asks every 15-20 s around a release, so keep the answer for 10 s
async function getCalendar(env, ctx, opts = {}) {
  const now = Date.now(), debug = !!opts.debug;
  if (calMemo && calMemo.debug === debug && now - calMemo.at < (opts.fresh ? 3000 : 10000)) return calMemo.body;   // ?fresh=1 (manual refresh) skips the 10 s reuse, at most every 3 s; the feeds, official source and KV writes keep their own throttles
  await Promise.all([loadSync(env), firstSeed(env), ledgerSeed(env), policySeed(env), offSeed(env)]);
  const sch = schedule(now);
  syncLazy(env, ctx, now);
  policyLazy(env, ctx, sch, now);   // facts never built, or a decision the series does not show yet   // an overdue sync source starts in the background (D77)
  const pw = wireSeed(env).then(() => feedWindow(env, ctx, 'FinancialJuice', wireHot(sch.events, now)))
    .catch(e => { wireSt.err = String(e.message).slice(0, 120); return { posts: [], status: 'broken' }; });   // polls Telegram only around a covered release
  const ffFast = ffHot(sch.events, now);   // a scheduled release is about to happen or just happened
  if (!feedState.kvSeeded) { feedState.kvSeeded = true; await feedFromKv(env); }   // a warm isolate that had no Forex Factory copy yet laid nothing over the schedule on its first build (25 Nov debug: matched 0 with a 9 h old copy held)
  await fvSeed(env);
  const p = Promise.all([feedRefresh(env, ctx, ffFast), offRefresh(env, ctx, sch), fvRefresh(env, ctx, INDICATORS, sch.events, now)]);
  if (!feedState.events && !offState.M) await Promise.race([p, new Promise(r => setTimeout(r, CAL_WAIT))]);   // cold start: give the providers a moment, never longer

  const [lo, hi] = calWindow(now);
  const base = sch.events.filter(e => e.t >= lo && e.t <= hi);
  const feeds = [];
  if (fvState.events && now - fvState.at < FV_USE_MAX) feeds.push({ name: 'Finviz', rows: fvOverlayRows(fvState.events), noTime: true });   // forecast and previous only; its actuals are applied after the wire
  if (feedState.events && now - feedState.at < CAL_USE_MAX) feeds.push({ name: 'Fair Economy', rows: feedState.events });
  const o = overlay(base, feeds, INDICATORS, now);
  const nRes = applyResults(o.events, RESULTS);
  const fw = await pw, wr = applyWire(o.events, fw.posts, now, wireSt.memo);   // blanks only; typed numbers (above) and provider numbers win
  if (wr.changed) wireSt.dirty = true;
  wireBackfill(env, ctx, base, now);   // released rows the wire covers that still miss a number: read the older posts from D1 in the background
  wireSt.feed = fw.status; if (fw.status !== 'broken') wireSt.err = null;
  o.issues.push(...wr.issues);
  const fa = fvState.events && now - fvState.at < FV_USE_MAX ? applyFvActuals(o.events, fvState.events, INDICATORS, now) : { n: 0, confirmed: 0, issues: [] };   // fills a blank or typed actual; confirms or flags the wire's
  o.issues.push(...fa.issues);
  if (recordPrev(firstSt.mem, o.events, now)) firstSt.dirty = true;   // the previous as the feeds and the wire show it: still before any revision
  const off = offState.M && now - offState.at < CAL_USE_MAX ? applyOfficial(o.events, offState.M, now, { ...firstLookups(firstSt.mem), vint: (ser, ob) => offState.V && offState.V[ser] && offState.V[ser].get(ob) }) : { n: 0, issues: [], skipped: [] };   // fills blanks, replaces typed placeholders, flags disagreements
  if (recordActual(firstSt.mem, o.events, now)) firstSt.dirty = true;
  if (firstSt.dirty && pruneFirst(firstSt.mem, now)) firstSt.dirty = true;
  const liveAc = new Set(o.events.filter(e => e.ac != null).map(e => e.id));   // actuals a live source gave this time (not the ledger's): the lag log counts only those
  ledgerSt.restored = applyLedger(o.events, ledgerSt.mem, now);   // what the live sources lost (a cold start, a lapse) comes back from the ledger, with its original tag
  if (recordLedger(ledgerSt.mem, o.events, now)) ledgerSt.dirty = true;
  if (ledgerSt.dirty) pruneLedger(ledgerSt.mem, now);
  histFill(env, ctx, base, now);   // older rows with no official actual in the ledger: read once from FRED's archive, in the background
  const gaps = forecastGaps(o.events, now, wireCovered);   // released rows the wire covers that still lack a forecast, previous or actual
  const pend = markPending(o.events, now, wireCovered);   // covered rows still without any actual: the page says "awaiting official figure"
  const lagNew = lagDetect(o.events, liveAc, now);
  if (lagNew.length) { const lw = recordLag(env, lagNew); if (ctx) ctx.waitUntil(lw); }
  o.issues.push(...off.issues);
  const decs = policyDecs(sch), nIso = nyDate(now), pb = policyBackdrop(policySt.facts, decs, now, nIso, policyVote());
  const backdrop = pb && pb.checked >= String(INDICATORS.backdrop.asof) ? pb : INDICATORS.backdrop;   // built facts beat the file's text only when they are the newer of the two (the file stays the fallback)
  o.issues.push(...policyIssues(policySt.facts, decs, now, nIso, INDICATORS.fams_reviewed, !!(env && env.FRED_KEY)));
  if (off.wire && off.wire.length && recordConfirms(wireSt.memo, off.wire, now)) wireSt.dirty = true;   // wire against official: the agree and disagree log
  const sv = wireSave(env, now); if (ctx) ctx.waitUntil(sv);
  const fv = firstSave(env, now); if (ctx) ctx.waitUntil(fv);
  const lv = ledgerSave(env, now); if (ctx) ctx.waitUntil(lv);
  o.issues.push(...sch.merged.issues, ...syncIssues(syncState.rec, now, INDICATORS, false));   // schedule sync: failures, overdue sources, dates that moved overnight
  chainPrevious(o.events);
  const repl = typedReplaced(o.events, RESULTS);   // typed placeholders a real source has replaced: safe to delete from results.json

  let fstat = feedState.status;
  if (feedState.events && ffStale(now - feedState.at, ffFast)) fstat = 'stale';
  else if (fstat === 'none' && feedState.failAt) fstat = 'unavailable';

  let ostat = offState.status;
  if (ostat === 'ok' && now - offState.at > OFF_SLOW * 2) ostat = 'stale';
  const a = sch.aud, all = o.issues.concat(a.issues);
  const status = a.status === 'error' || o.issues.some(i => i.lvl === 'error') ? 'error' : (a.status === 'check' || o.issues.length) ? 'check' : 'ok';
  const out = {
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    now,                                                  // the page compares this with its own clock
    src: 'official release schedule',
    sources: SCHEDULE.sources, checked: sch.checked, kinds: KINDS_PUBLIC, fams: INDICATORS.fams, backdrop,   // what the page needs to explain each release
    feed: { status: fstat, mode: ffFast ? 'release window (5 min, this week only)' : 'normal (30 min)', at: feedState.at || null, matched: o.matched, extras: o.extras, error: fstat === 'ok' ? null : feedState.err },
    official: { status: ostat, via: offState.via, at: offState.at || null, n: off.n, error: offState.err, awaiting: pend.length, held: off.skipped.length },   // held: rows FRED has a value for that was not shown, with the reason in ?debug=1
    finviz: { ...fvHealth(now), filled: fa.n, confirmed: fa.confirmed },
    ledger: { rows: Object.keys(ledgerSt.mem.rows).length, restored: ledgerSt.restored, gaps: gaps.length },   // restored: fields put back this time because a live source had none or a lesser one
    results: { asof: RESULTS.asof || null, n: nRes, replaced: repl.length, first: Object.keys(firstSt.mem.rows).length },
    wire: { status: fw.status, n: wr.n, error: wireSt.err, ...wireSummary(wireSt.memo) },   // FinancialJuice actuals filled this time, and how often the wire matched the official number so far
    sync: { ...syncSummary(syncState.rec), tiers: sch.merged.tiers, stats: sch.merged.stats },   // what the schedule check shows
    audit: { status, nIssues: a.nIssues + o.issues.length, counts: a.counts, total: a.total, first: a.first, horizon: a.horizon,
      checked: a.checked, issues: all.slice(0, 25) },
    events: o.events,
  };
  if (debug) out.debug = { gaps: gaps.slice(0, 60), backfill: bfSt, history: { ...histSt, tried: Object.keys(histSt.tried).length }, officialKv: { seeded: offKv.seeded, savedAt: offKv.savedAt || null }, policy: { ...policyHealth(env), facts: policySt.facts, vote: policySt.vote, using: pb ? (backdrop === pb ? 'built' : 'file (newer than the facts)') : 'file (no facts)' }, replaced: repl.slice(0, 40), first: Object.fromEntries(Object.entries(firstSt.mem.rows).slice(-40)), fair: { n: (feedState.events || []).length, sample: (feedState.events || []).slice(0, 3), titles: (feedState.events || []).map(r => r.title + ' ' + etD(r.t)).slice(0, 80) },
    fv: { n: (fvState.events || []).length, week: (fvState.events || []).filter(r => r.t > now - 864e5 && r.t < now + 4 * 864e5).map(r => `${etD(r.t)} ${r.title} | fc ${r.fc} pv ${r.pv} ac ${r.ac}`).slice(0, 60) },
    official: { via: offState.via, error: offState.err, errors: offState.errList || [], lastRun: offState.lastRun || null, skipped: off.skipped, awaiting: pend, vintages: Object.fromEntries(Object.entries(offState.V || {}).map(([k, m]) => [k, Object.fromEntries([...m].slice(-4))])), series: Object.fromEntries(Object.entries(offState.M || {}).map(([k, m]) => { const d = [...m.keys()].sort().pop(); return [k, { rows: m.size, lastObs: d, last: m.get(d) }]; })) }, unmatched: o.unmatched,
    wire: { feed: fw.status, window: fw.posts.length, newest: fw.posts[0] ? fw.posts[0].t : null, unmatchedMacro: wr.unmatched, rows: wireSt.memo.rows } };
  const body = JSON.stringify(out);
  calMemo = { at: now, debug, body, out };   // out: the same answer as an object, for /alerts (no second JSON.parse)
  return body;
}
async function getCalendarObj(env, ctx) { await getCalendar(env, ctx); return calMemo && calMemo.out ? calMemo.out : null; }

// ---- alerts (plan P8.34 stage 1): what the page's toasts would say, from the Worker's own data ----
let alertMemo = null;
// opts.wire / opts.cal: which parts to build. The pollers build only their own part (the 1-minute poller the wires, the 2-minute poller the calendar), /alerts builds both.
async function getAlerts(env, ctx, opts = {}) {
  const wire = opts.wire !== false, cal = opts.cal !== false, full = wire && cal, now = Date.now();
  const back = Math.min(Math.max(Number(opts.back) || 0, 0), 6 * 36e5);   // the page panel's history view: wire posts and releases up to this old (GET /alerts?back=)
  if (full && !back && alertMemo && Math.abs(now - alertMemo.at) < 5000) return alertMemo;
  const errors = [];
  let fj = [];   // Walter Bloomberg was retired on 24 Nov (its Telegram preview went dark; the Finviz card replaced it): no dm posts are read, so buildAlerts gets its default dm = []
  if (wire) {
    const r = await loadPosts(env, 'FinancialJuice', back ? 200 : 60);
    if (!r) errors.push('FinancialJuice posts could not be read from D1');
    fj = r || [];
  }
  let c = null;
  if (cal) { try { c = await getCalendarObj(env, ctx); } catch (e) { errors.push('calendar: ' + String(e && e.message).slice(0, 100)); } }
  const seen = c && c.events.some(e => e.ac != null) ? await loadLagSeen(env, now - 6 * 36e5) : {};
  const list = buildAlerts({ now, fj, events: c ? c.events : [], fams: c ? c.fams : {}, seen, wire, cal, back, remMins: REM_MENU });   // every reminder time is built; applySettings keeps the ticked ones
  if (full) for (const t of await loadTests(env, now - 10 * 60e3)) list.unshift(testAlert(t));   // the test alerts of the last 10 minutes
  const out = { at: now, now, list, errors };
  if (full && !back) alertMemo = out;
  return out;
}

// ---- last resort: the data branch written by the GitHub Action (only while USE_DATA_BRANCH) ----
let fb = null;
async function dataBranch() {
  if (fb && Date.now() - fb.at < 5 * 60000) return fb.v;
  let v = {};
  try { v = JSON.parse(await get(FALLBACK_URL)); } catch (e) { /* none available */ }
  fb = { at: Date.now(), v };
  return v;
}

const FUT_LIVE_TTL = 10 * 60000;   // while a future's price is live from the TradingView push, Yahoo is asked about it only this often (contract name, ROLLED)
async function build(ctx, env) {
  const log = [], notes = [];
  fredKey = (env && env.FRED_KEY) || null;
  const tv = env && env.TV_OVERLAY === 'off' ? null : await loadTv(env);   // TradingView push (D1), read first so live futures need no Yahoo call; set the Worker variable TV_OVERLAY to "off" to stop publishing pushed prices
  const t0 = Date.now(), liveFut = new Set();
  if (tv) for (const [label, kind] of TV_LABELS) {   // an item the push covers right now (a future needs a recent Yahoo answer in the cache: it holds the contract name; the others need only a cached value), so it costs no source call
    const c = itemCache.get(label);
    if (c && c.val && (kind !== 'fut' || c.val.contract) && !c.failAt && t0 - c.at < FUT_LIVE_TTL && (tvOverlay(c.val, tv, t0, quote) || {}).live) liveFut.add(label);
  }
  const work = Promise.all([...ITEMS.filter(([l]) => !liveFut.has(l)).map(([l, k, c]) => getItem(l, k, c, log, notes)), getFng()]);
  const done = await Promise.race([work.then(() => true), new Promise(r => setTimeout(() => r(false), DEADLINE_MS))]);
  if (ctx) ctx.waitUntil(work);   // late sources keep running and land in the cache for the next request
  if (!done) notes.push(`deadline hit (${DEADLINE_MS} ms): slow sources will show in the next response`);

  const now = Date.now();
  let prev = {};
  if (USE_DATA_BRANCH && (!fngState.val || ITEMS.some(([l]) => !(itemCache.get(l) || {}).val))) prev = await dataBranch();
  const prevItems = Object.fromEntries((prev.items || []).map(i => [i.label, i]));

  const items = ITEMS.map(([label, kind]) => {
    const c = itemCache.get(label);
    if (c && c.val) {
      const stale = (c.failAt && c.failAt > c.at) || now - c.at > (liveFut.has(label) ? FUT_LIVE_TTL : c.ttl) + 60000;   // a live item is not stale because its source was skipped
      return stale ? { ...c.val, stale: true, why: c.why } : c.val;   // a stale tile shows only a V1 refusal as its reason (a V2 note belongs to the reading, not to the failure)
    }
    return prevItems[label] ? { ...prevItems[label], stale: true } : { label, kind, p: null };
  }).map(it => tvOverlay(it, tv, now, quote)).map(it => ({ ...it, ...META[it.label] }));

  const out = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),   // when this response was built, not when the quotes were made
    items,
    fng: fngState.val ?? prev.fng ?? null,
    errors: log.slice(0, 20),
    notes: notes.slice(0, 10),
    via: 'worker',
  };
  if (fngState.err) out.fng_error = fngState.err;
  return out;
}

// ---- response cache: serve instantly, refresh in the background ----
let memo = null;      // { at, body }
let inflight = null;  // share one build between simultaneous requests
let seeded = false;
let lastKvWrite = 0;

async function seed(env) {
  seeded = true;
  if (!env || !env.MARKET_KV) return;
  try {
    const snap = await env.MARKET_KV.get(KV_KEY, 'json');
    if (!snap || !Array.isArray(snap.items)) return;
    for (const it of snap.items) {
      if (it.p == null || itemCache.has(it.label)) continue;
      const { stale, unv, why, ...val } = it;   // a saved V1 or V2 note belongs to the moment it was made: the reading is refetched at once
      itemCache.set(it.label, { val, at: val.f || 0, ttl: 0 });   // last good value + roll history; refetched at once
    }
    if (snap.fng && !fngState.val) { fngState.val = snap.fng; fngState.at = 0; }
    const at = Date.parse(snap.updated);
    if (!memo && at) memo = { at, body: JSON.stringify(snap) };
  } catch (e) { /* KV unavailable: carry on without it */ }
}

function refresh(env, ctx, noKv) {   // noKv: a manual refresh (?fresh=1) adds no KV write
  if (!inflight) {
    inflight = build(ctx, env).then(async b => {
      const body = JSON.stringify(b);
      memo = { at: Date.now(), body };
      if (!noKv && env && env.MARKET_KV && Date.now() - lastKvWrite > KV_GAP) {
        lastKvWrite = Date.now();
        try { await env.MARKET_KV.put(KV_KEY, body); } catch (e) { /* ignore */ }
      }
      return body;
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

async function getMarket(env, ctx, opts = {}) {
  if (!seeded) await seed(env);
  const age = memo ? Date.now() - memo.at : Infinity;
  if (opts.fresh && age >= MIN_FRESH) {   // manual refresh: wait for a new build (still capped by DEADLINE_MS). Each item still follows its own reuse time and failure back-off, and no KV write is added
    try { return await refresh(env, ctx, true); } catch (e) { if (memo) return memo.body; throw e; }
  }
  if (age < TTL_FAST) return memo.body;
  if (age < STALE_OK) {
    const p = refresh(env, ctx);
    if (ctx) ctx.waitUntil(p.catch(() => {}));
    return memo.body;
  }
  try { return await refresh(env, ctx); }
  catch (e) { if (memo) return memo.body; throw e; }
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Push-Key',
      'Access-Control-Expose-Headers': 'X-Server-Time',   // P8.38: lets the page read the Worker's clock at the moment of the reply (the body's `now` is the build time, up to 10 s older)
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(req.url);
    const json = { ...cors, 'Content-Type': 'application/json; charset=utf-8' };   // charset so a browser's raw JSON view does not show UTF-8 text as â€™ and ðŸ”¸
    if (pathname === '/health') {
      // P8.36: every block reads stored state (KV or D1), not just this isolate's memory, so a cold read shows what the pollers hold (the same as /calendar?debug=1)
      const [poller] = await Promise.all([pollerHealth(env), loadSync(env), policySeed(env), wireSeed(env), curveSeed(env), feedFromKv(env), seed(env).then(() => weekly.seed(env)), sectors.seed(env)]);
      const now = Date.now(), ageOf = at => (at ? Math.round((now - at) / 1000) : null);
      const offAge = offState.at ? ageOf(offState.at) : poller.official_ok_age_s;   // the official data is memory only; the last full download is kept as a mark in D1
      return new Response(JSON.stringify({
        ok: true, kv: !!(env && env.MARKET_KV),
        memo_age_s: memo ? Math.round((now - memo.at) / 1000) : null,
        cached_items: itemCache.size,
        calendar: { audit: schedule(now).aud.status, feed: feedState.status === 'none' && feedState.events ? 'ok' : feedState.status, feed_age_s: ageOf(feedState.at),
          official: offState.status === 'none' && offAge != null ? 'ok' : offState.status, official_age_s: offAge, finviz: fvHealth(now),
          wire: { feed: wireSt.feed === 'none' ? 'idle' : wireSt.feed, ...wireSummary(wireSt.memo || newMemo()) } },   // idle = no release the wire covers has needed a poll in this isolate yet
        tv: tvHealth(await loadTv(env), env),
        sectors: sectors.health(), weekly: weekly.health(),
        validation: valHealth(),   // plan P8.16: V1 refusals and V2 tags right now (the audit reads this)
        curve: { asof: curve.memo ? curve.memo.asof : null, age_s: curve.memo && curve.memo.at ? Math.round((now - curve.memo.at) / 1000) : (curve.memo && curve.memo.updated ? ageOf(Date.parse(curve.memo.updated)) : null), check: curve.memo ? curve.memo.check : null, error: curve.err },
        sync: syncHealth(),
        poller,
        policy: policyHealth(env),   // the policy facts job: when it last confirmed the facts, the range read, whether the vote was found
        controls: await loadSettings(env),   // the control center: master switch, which reminders are sent, and when each was last switched on
        push: await pushHealth(env),   // phone alerts: is a key set, how many phones, when each last accepted a push, the last error
        official: { lag: await loadLag(env) },   // per release row: seconds from the release time to the first actual from any source, and which source (about 5 to 15 rows a day, newest first)
        wire: { ...feedHealth(), channels: Object.fromEntries(Object.keys(CHANNELS).map(n => [n, feedHealth(Date.now(), n)])) },   // the DeItaone fields as before, plus every channel; FinancialJuice "hot" = flagged posts in the window
      }), { headers: json });
    }
    if (pathname === '/ingest') {   // TradingView webhook target (src/tv.js); the secret travels in the JSON body because TradingView cannot set headers
      if (req.method !== 'POST') return new Response('{"error":"POST only"}', { status: 405, headers: json });
      const r = await tvIngest(req, env, TV_LABELS, Date.now(), RANGES);   // RANGES: the V1 bounds from symbols.json (plan P8.16)
      return new Response(JSON.stringify(r.out), { status: r.status, headers: { ...json, 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/tv') {   // read only: what the last push held and whether it still counts as live
      return new Response(JSON.stringify(tvHealth(await loadTv(env), env)), { headers: { ...json, 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/market') {
      try {
        const fresh = isFresh(req.url);
        let out = await getMarket(env, ctx, { fresh });
        if (!(env && env.TV_OVERLAY === 'off')) out = tvMarket(out, await loadTv(env), Date.now(), quote);   // live futures at response time, not at build time (src/tv.js)
        return new Response(out, { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/calendar') {
      try {
        return new Response(await getCalendar(env, ctx, { debug: new URL(req.url).searchParams.has('debug'), fresh: isFresh(req.url) }), { headers: { ...json, 'Cache-Control': 'no-store', 'X-Server-Time': String(Date.now()) } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: { ...json, 'X-Server-Time': String(Date.now()) } });
      }
    }
    if (pathname === '/sectors' || pathname === '/weekly') {
      try {
        const route = pathname === '/sectors' ? sectors : weekly, fresh = isFresh(req.url);
        if (route === weekly && !seeded) await seed(env);   // load the tape's last snapshot first: its roll flags feed the week-open check
        let out = await route.get(env, ctx, { fresh });
        if (!(env && env.TV_OVERLAY === 'off')) out = route === weekly
          ? tvWeekly(out, await loadTv(env), Date.now(), TV_WEEKLY)   // live price and week open from the TradingView push, when fresh (src/tv.js)
          : tvMarket(out, await loadTv(env), Date.now(), quote);      // live sector ETFs, each only while its own bar is recent (P8.28)
        if (!(env && env.TV_OVERLAY === 'off')) { const th = tvHealth(await loadTv(env), env), j = JSON.parse(out); j.tv = { live: th.live, age_s: th.push_age_s }; out = JSON.stringify(j); }   // the card says WHY it is delayed: the TradingView push is off, or only does not cover these items
        return new Response(out, { headers: { ...json, 'Cache-Control': fresh ? 'no-store' : 'public, max-age=20' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    const keyGate = () => {   // the pairing key (the secret PUSH_KEY) in the X-Push-Key header: null when it is right, otherwise the refusal to return
      if (!(env && env.PUSH_KEY)) return new Response(JSON.stringify({ error: 'PUSH_KEY is not set: add it as a secret in Cloudflare (Worker, Settings, Variables and Secrets)' }), { status: 503, headers: json });
      if (!checkKey(env, req.headers.get('X-Push-Key'))) return new Response(JSON.stringify({ error: 'wrong pairing key' }), { status: 401, headers: json });
      return null;
    };
    if (pathname.startsWith('/push/')) {   // phone setup. Every route needs the pairing key
      if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: json });
      const denied = keyGate();
      if (denied) return denied;
      let body = {};
      try { body = await req.json(); } catch (e) { /* an empty body is fine */ }
      const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...json, 'Cache-Control': 'no-store' } });
      if (pathname === '/push/setup') {   // makes the VAPID key on first use; returns the public part the phone subscribes with
        const v = await getVapid(env, true);
        return v ? reply({ key: v.pub, subs: (await loadSubs(env)).length }) : reply({ error: 'could not make or read the VAPID key (KV binding?)' }, 500);
      }
      if (pathname === '/push/subscribe') {
        if (!validEndpoint(body.endpoint)) return reply({ error: 'not a push service address' }, 400);
        const ok = await saveSub(env, body.endpoint, req.headers.get('User-Agent'), body.keys);
        return ok ? reply({ ok: true, subs: (await loadSubs(env)).length }) : reply({ error: 'could not save the subscription (D1 binding?)' }, 500);
      }
      if (pathname === '/push/unsubscribe') { await dropSub(env, String(body.endpoint || '')); return reply({ ok: true, subs: (await loadSubs(env)).length }); }
      if (pathname === '/push/test') {
        const t = Date.now();
        await recordTest(env, t);
        alertMemo = null;
        const r = await sendAll(env, t, body && body.text ? { alerts: [testAlert(t)] } : {});   // { text: true }: the test carries its own text, to try the encrypted push before switching it on
        return reply({ ok: r.sent > 0, ...r });
      }
      if (pathname === '/push/devices' || pathname === '/push/remove') {   // the devices registered for push, and removal of one (control center). body.endpoint = this device's own address, so the list can mark it
        const now = Date.now();
        if (pathname === '/push/remove') {
          const id = String(body.id || '');
          let hit = null;
          for (const r of await loadSubs(env)) { const ep = epOf(r); if (ep && (await deviceId(ep)) === id) { hit = ep; break; } }
          if (!hit) return reply({ error: 'no such device (it may already be removed)' }, 404);
          await dropSub(env, hit);
        }
        const rows = await loadSubs(env);
        return reply({ ok: true, now, devices: await listDevices(rows, now, body.endpoint ? String(body.endpoint) : null), shape: rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]) : null });   // shape: the field names push.js keeps per device, for diagnosis
      }
      return reply({ error: 'unknown push route' }, 404);
    }
    if (pathname === '/alerts/prefs') {   // which alert kinds reach the phone (plan P8.34 stage 4). GET = the switches, PUT { kinds: { fj: false, ... } } = change some of them. Needs the pairing key
      if (req.method !== 'GET' && req.method !== 'PUT') return new Response(JSON.stringify({ error: 'GET or PUT only' }), { status: 405, headers: json });
      const denied = keyGate();
      if (denied) return denied;
      const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...json, 'Cache-Control': 'no-store' } });
      if (req.method === 'PUT') {
        let body = null;
        try { body = await req.json(); } catch (e) { return reply({ error: 'the body must be JSON, for example { "kinds": { "fj": false } }' }, 400); }
        const saved = await savePrefs(env, body && body.kinds, Date.now());
        if (!saved) return reply({ error: 'nothing saved: send at least one of ' + PREF_KINDS.join(', ') + ' as true or false (and the Worker needs its KV binding)' }, 400);
        return reply({ ok: true, kinds: saved.kinds, at: saved.at, available: PREF_KINDS });
      }
      const p = await loadPrefs(env);
      return reply({ kinds: p.kinds, at: p.at, available: PREF_KINDS });
    }
    if (pathname === '/alerts/settings') {   // the push control center: GET = everything, PUT { master?, remind?: { 15|5|0: bool }, kinds?: { fj|remind|release|fix: bool } }. Applies to every device. Needs the pairing key
      if (req.method !== 'GET' && req.method !== 'PUT') return new Response(JSON.stringify({ error: 'GET or PUT only' }), { status: 405, headers: json });
      const denied = keyGate();
      if (denied) return denied;
      const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...json, 'Cache-Control': 'no-store' } });
      if (req.method === 'PUT') {
        let body = null;
        try { body = await req.json(); } catch (e) { return reply({ error: 'the body must be JSON, for example { "master": false }' }, 400); }
        const now = Date.now(), r = await saveSettings(env, body, now);
        const kinds = body && body.kinds ? await savePrefs(env, body.kinds, now) : null;
        if (!r.valid && !kinds) return reply({ error: 'nothing saved: send master, payload, remind (' + REMIND_MINS.join(', ') + ') or kinds as true or false' }, 400);
        if (r.valid && r.saved === false) return reply({ error: 'could not save (the Worker needs its KV binding)' }, 500);
      }
      const st = await loadSettings(env), p = await loadPrefs(env);
      return reply({ ok: true, master: st.master, payload: st.payload === true, remind: st.remind, remindMins: REMIND_MINS, kinds: p.kinds, available: PREF_KINDS, at: Math.max(st.at || 0, p.at || 0) });
    }
    if (pathname === '/alerts') {   // what is an alert right now. ?since=<ms> lists only what happened after that moment; a client shows each id once. The phone's switches (stage 4) apply, so the phone shows exactly what a push was sent for; ?all=1 lists everything (diagnosis)
      try {
        const q = new URL(req.url).searchParams, a = await getAlerts(env, ctx, { back: Number(q.get('back')) || 0 }), since = Number(q.get('since')) || 0;
        const list = q.has('all') ? a.list : applySettings(filterPrefs(a.list, await loadPrefs(env)), await loadSettings(env));
        return new Response(JSON.stringify({ now: a.now, since, alerts: filterAlerts(list, since), errors: a.errors }), { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/curve') {
      try {
        const fresh = isFresh(req.url);
        return new Response(await getCurve(env, ctx, { fresh }), { headers: { ...json, 'Cache-Control': fresh ? 'no-store' : 'public, max-age=60' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/sync') {   // read only: the state of the schedule sync (add ?debug=1 for the samples kept when a source could not be read)
      await loadSync(env, true);
      const now = Date.now(), rec = syncState.rec, m = schedule(now).merged;
      const body = { now, crons: SYNC_CRONS, running: syncState.running, lastRun: syncState.last, ...syncSummary(rec), tiers: m.tiers, stats: m.stats,
        issues: syncIssues(rec, now, INDICATORS, false).concat(m.issues) };
      if (new URL(req.url).searchParams.has('debug') && rec) body.debug = Object.fromEntries(Object.entries(rec.src || {}).filter(([, s]) => s.debug).map(([n, s]) => [n, s.debug]));
      return new Response(JSON.stringify(body), { headers: { ...json, 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/feed') {
      try {
        const q = new URL(req.url).searchParams;
        const debug = q.has('debug');                  // /feed?debug=1 adds a markup sample when the parser finds nothing
        const channel = q.get('ch');                   // /feed = both channels; /feed?ch=FinancialJuice = that one alone
        if (channel && !Object.prototype.hasOwnProperty.call(CHANNELS, channel)) {   // verified channels only (D47, D78): never a proxy for arbitrary t.me pages
          return new Response(JSON.stringify({ error: 'unknown channel', channels: Object.keys(CHANNELS) }), { status: 400, headers: json });
        }
        const fresh = isFresh(req.url);                // ?fresh=1: poll again after 3 s instead of 10 s; the failure back-off still applies
        const body = channel ? await getFeed(env, ctx, { debug, channel, fresh }) : await getFeeds(env, ctx, { debug, fresh });
        return new Response(body, { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/finviz') {   // Finviz news headlines parsed from finviz.com/news; ?fresh=1 = manual refresh, ?debug=1 adds row counts and health
      try {
        const q = new URL(req.url).searchParams, fresh = isFresh(req.url);
        return new Response(await getFinviz(env, ctx, { fresh, debug: q.has('debug') }), { headers: { ...json, 'Cache-Control': fresh ? 'no-store' : 'public, max-age=20' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/finviz-test') {   // TEST ONLY, read only: one request to Finviz at most every 60 s; remove once the real route replaces it
      try { return new Response(await finvizProbe(req.url), { headers: { ...json, 'Cache-Control': 'no-store' } }); }
      catch (e) { return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json }); }
    }
    if (pathname === '/fvcal-test') {   // TEST ONLY, read only: one request to Finviz's economic calendar at most every 60 s; remove once the real route replaces it
      try { return new Response(await fvCalProbe(req.url), { headers: { ...json, 'Cache-Control': 'no-store' } }); }
      catch (e) { return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json }); }
    }
    return new Response('{"error":"not found"}', { status: 404, headers: json });
  },
  async scheduled(event, env, ctx) {   // Cron Triggers (wrangler.toml): the nightly schedule sync, one source per trigger
    const name = SYNC_CRONS[event.cron], at = event.scheduledTime || Date.now();
    if (name) ctx.waitUntil(runSyncSource(name, env).catch(() => {}));
    else if (event.cron === POLL_FEEDS) ctx.waitUntil(pollFeeds(env, ctx, at).catch(e => console.log('poll feeds: ' + String(e && e.message))));
    else if (event.cron === POLL_CAL) ctx.waitUntil(pollCalendar(env, ctx, at).catch(e => console.log('poll calendar: ' + String(e && e.message))));
  },
};