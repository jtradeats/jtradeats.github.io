// Market Dashboard Worker: primary data path for news.html (JS port of dashboard_data.py).
// GET /market -> JSON for the page. GET /feed -> both Telegram wires in one answer: DeItaone at the top level, FinancialJuice under "fj" (flagged posts carry hot:true); ?ch=<channel> returns one channel alone. GET /calendar -> release schedule with forecast/previous/actual (?debug=1 shows provider samples and unmatched titles). GET /curve -> Treasury yield curve, spreads and changes (official close, cross-checked against FRED T10Y2Y; plan P6). GET /sectors -> the 11 sector ETFs plus SPY (plan P4). GET /weekly -> week open vs current for NQ, ES, DOW, RTY, GC, CL (plan P5); both accept ?fresh=1 (manual refresh). GET /health -> small status object.
// No API keys needed. Optional KV binding named MARKET_KV keeps a snapshot across cold starts.

import SYMBOLS from '../config/symbols.json';
import SCHEDULE from '../config/schedule.json';
import INDICATORS from '../config/indicators.json';
import RESULTS from '../config/results.json';
import { etToMs, etParts, expand, audit, overlay, normFair, normFmp, applyResults, typedReplaced, chainPrevious } from './schedule.js';
import { ffHot, ffTtl, ffRetry, ffStale, mergeFeed } from './feedpoll.js';   // Forex Factory refresh plan: this week's file every 5 min around a release (P8.24)
import { FP_KV, newFirst, fromKv, recordPrev, recordActual, prune as pruneFirst, lookups as firstLookups } from './firstprint.js';   // first prints: what a release showed before any revision (P8.23)
import { beat, beats, prunePosts, postsSummary, postsError } from './posts.js';   // Telegram posts and the poller's heartbeats in D1 (plan P8.31)
import { LG_KV, newLedger, fromKv as ledgerFromKv, recordLedger, applyLedger, pruneLedger } from './ledger.js';   // the best actual each release has shown, kept in KV (plan P8.30)
import { SPEC as OFF_SPEC, SERIES as OFF_SERIES, parseFredCsv, parseFredJson, fredApiUrl, eiaApiUrl, parseEiaJson, applyOfficial } from './official.js';
import { SYNC_KEY, runBls, runFred, runTreasury, runProvider, mergeSchedule, diffSchedules, syncIssues, syncSummary, dueSources } from './schedule_sync.js';   // nightly schedule sync (plan P2, P3)
import { getFeed, getFeeds, feedHealth, feedWindow, CHANNELS } from './feed.js';   // DeItaone and FinancialJuice wires via the Telegram mirror (plan 1.5)
import { WIRE_KV, WIRE_KEYS, applyWire, newMemo, recordConfirms, wireSummary } from './wire.js';   // FinancialJuice actuals (plan P8.19 stage 2)
import { makeSectors } from './sectors.js';   // /sectors (plan P4)
import { makeWeekly } from './weekly.js';   // /weekly (plan P5)
import { buildCurve, parseTreasuryCsv } from './curve.js';   // /curve (plan P6)
import { tvIngest, loadTv, tvOverlay, tvWeekly, tvMarket, tvHealth } from './tv.js';   // live futures from a TradingView alert: POST /ingest, GET /tv
import { backoffTtl } from './route.js';   // closed-market back-off (shared with /sectors)

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
function treasuryRows(year) {
  const c = trCache.get(year);
  if (c && Date.now() - c.at < TTL_SLOW) return c.p;
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
async function buildCurveNow(env) {
  const y = new Date().getUTCFullYear();
  const since = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  const [cur, prev, fred] = await Promise.allSettled([
    treasuryRows(y), treasuryRows(y - 1),
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
function refreshCurve(env) {
  if (!curve.inflight) {
    curve.inflight = buildCurveNow(env)
      .then(b => { curve.err = null; return b; })
      .catch(e => { curve.err = String(e.message).slice(0, 160); curve.errAt = Date.now(); throw e; })
      .finally(() => { curve.inflight = null; });
  }
  return curve.inflight;
}
async function getCurve(env, ctx) {
  if (!curve.seeded) {
    curve.seeded = true;
    if (env && env.MARKET_KV) {
      try { const s = await env.MARKET_KV.get(CURVE_KV, 'json'); if (s && s.asof) { curve.memo = { at: 0, body: JSON.stringify(s), asof: s.asof, check: s.check && s.check.status }; curve.kvAsof = s.asof; } } catch (_) { /* no KV */ }
    }
  }
  if (curve.memo && Date.now() - curve.memo.at < CURVE_TTL) return curve.memo.body;
  if (curve.memo && Date.now() - curve.errAt < NEG_TTL && curve.err) return curve.memo.body;   // the last refresh failed: do not hammer Treasury
  const p = refreshCurve(env);
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
  for (const [src, sym] of chain) {
    try {
      let got = await SOURCES[src](sym);
      if (kind === 'yield') got = fixYield(got);
      if (!Number.isFinite(got.p)) throw new Error('bad price');
      got = { label, kind, src: `${src}:${sym}`, f: Date.now(), ...got };
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
    } catch (e) { log.push(`${label} ${src}:${sym} failed: ${e.message}`.slice(0, 200)); }
  }
  itemCache.set(label, { ...c, failAt: Date.now() });
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
// Numbers come from three optional layers, lowest priority first:
//   1. Fair Economy / Forex Factory weekly feeds: forecast and previous, no actuals, rate-limits shared Cloudflare IPs (HTTP 429). No key.
//   2. Financial Modeling Prep economic calendar: forecast, previous AND actual. Needs a free key in the Worker secret FMP_KEY.
//   3. worker/config/results.json: numbers typed in by hand. PLACEHOLDERS: they fill only what no real source has supplied, and the wire and FRED replace them.
// A failure in any layer leaves the schedule untouched and only changes the status fields.
const CAL_FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
// Refresh times live in src/feedpoll.js: both files every 30 min in quiet hours; around a release (10 min before to 45 min after) only this week's file, every 5 min.
const CAL_USE_MAX = 12 * 3600e3;     // never lay a feed copy older than this over the schedule
const CAL_WAIT = 1200;               // a first request waits at most this long for the providers, then answers without them
const CAL_WINDOW = [-31 * 864e5, 60 * 864e5];   // "this month" and "yesterday" need the past, "next week" the future
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
  return { events: normFair(raw, INDICATORS), notes };   // INDICATORS: keeps Forex Factory's Low-rated crude row (P8.33)
}

// Bring the Fair Economy copy up to date if it is due. Never throws; records the outcome in feedState.
async function refreshFeed(env, hot = false) {
  const now = Date.now(), ttl = ffTtl(hot);
  if (feedState.events && now - feedState.at < ttl) return;
  // every isolate would otherwise ask the feed on its own, so share one good copy through KV
  if (env && env.MARKET_KV) {
    try {
      const sn = await env.MARKET_KV.get(CAL_KEY, 'json');
      if (sn && sn.events && sn.at > feedState.at) { feedState.events = sn.events; feedState.at = sn.at; feedState.status = 'ok'; }
    } catch (e) { /* KV unavailable: carry on */ }
    if (feedState.events && Date.now() - feedState.at < ttl) return;
  }
  if (feedState.failAt && now - feedState.failAt < ffRetry(feedState.rate, hot)) return;
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
  }
}
function feedRefresh(env, ctx, hot) {
  if (!feedState.inflight) {
    feedState.inflight = refreshFeed(env, hot).finally(() => { feedState.inflight = null; });
    if (ctx) ctx.waitUntil(feedState.inflight);
  }
  return feedState.inflight;
}

// ---- Financial Modeling Prep (licensed API, free key; gives actuals) ----
// Polls every 30 min, and every 90 s from 25 min before to 2 min after a high-impact release, so an actual lands on the page within about a minute or two.
// Worst case about 120 calls a day (free plan: 250). KV share: at most one write per 10 min, only when the slow tier refreshed or an actual appeared.
const FMP_URL = 'https://financialmodelingprep.com/stable/economic-calendar';
const FMP_SLOW = 30 * 60000, FMP_FAST = 90000, FMP_RETRY = 5 * 60000, FMP_RETRY_LIMIT = 30 * 60000, FMP_KV = 'calendar:fmp', FMP_KV_GAP = 10 * 60000;
const fmpState = { events: null, at: 0, failAt: 0, err: null, status: 'no-key', inflight: null, lastKv: 0, nAct: 0, sample: null, limited: false };

async function loadFmp(env) {
  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const j = JSON.parse(await get(`${FMP_URL}?from=${day(-4)}&to=${day(35)}&country=US&apikey=${encodeURIComponent(env.FMP_KEY)}`, { Accept: 'application/json' }, 6000));
  if (!Array.isArray(j)) throw new Error(String((j && (j['Error Message'] || j.message || j.error)) || 'unexpected payload').slice(0, 140));
  fmpState.sample = j.slice(0, 3);
  return normFmp(j);
}

async function refreshFmp(env, sch) {
  if (!(env && env.FMP_KEY)) { fmpState.status = 'no-key'; return; }
  const now = Date.now();
  const near = sch.events.some(e => e.imp === 3 && !e.hol && e.t > now - 25 * 60000 && e.t < now + 120000);
  if (fmpState.events && now - fmpState.at < (near ? FMP_FAST : FMP_SLOW)) return;
  if (!fmpState.events && env.MARKET_KV) {
    try {
      const sn = await env.MARKET_KV.get(FMP_KV, 'json');
      if (sn && sn.events && sn.at > fmpState.at) { fmpState.events = sn.events; fmpState.at = sn.at; fmpState.status = 'ok'; fmpState.nAct = sn.events.filter(x => x.ac != null).length; }
    } catch (e) { /* KV unavailable: carry on */ }
    if (fmpState.events && Date.now() - fmpState.at < (near ? FMP_FAST : FMP_SLOW)) return;
  }
  if (fmpState.failAt && now - fmpState.failAt < (fmpState.limited ? FMP_RETRY_LIMIT : FMP_RETRY)) return;
  try {
    const ev = await loadFmp(env);
    const nAct = ev.filter(x => x.ac != null).length, changed = nAct !== fmpState.nAct;
    fmpState.events = ev; fmpState.at = Date.now(); fmpState.failAt = 0; fmpState.err = null; fmpState.limited = false; fmpState.status = 'ok'; fmpState.nAct = nAct;
    if (env.MARKET_KV && Date.now() - fmpState.lastKv > FMP_KV_GAP && (!near || changed)) {
      fmpState.lastKv = Date.now();
      try { await env.MARKET_KV.put(FMP_KV, JSON.stringify({ at: fmpState.at, events: ev })); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    fmpState.failAt = Date.now(); fmpState.err = String(e.message).replace(/apikey=[^&\s]*/gi, 'apikey=***').slice(0, 200);
    fmpState.limited = /HTTP (402|403|429)|limit|plan|subscription/i.test(fmpState.err);
    fmpState.status = /HTTP (401|402|403)|invalid|plan|subscription/i.test(fmpState.err) ? 'rejected' : fmpState.limited ? 'rate-limited' : 'unavailable';
  }
}
function fmpRefresh(env, ctx, sch) {
  if (!fmpState.inflight) {
    fmpState.inflight = refreshFmp(env, sch).finally(() => { fmpState.inflight = null; });
    if (ctx) ctx.waitUntil(fmpState.inflight);
  }
  return fmpState.inflight;
}

// ---- official actuals (plan 3.5): the release numbers computed from FRED series (see SPEC in official.js for which rows) ----
// With the secret FRED_KEY (free key, the same one the BLS-date fallback uses) the series come from FRED's API. Without it they come from the keyless graph CSV,
// which FRED refuses from Cloudflare's addresses (HTTP 520 on 16 Nov), so the key is what makes this work.
// Polls every 30 min, and every 60 s from 2 min before a release it covers to 90 min after it, so the actual lands as soon as FRED has it.
// FRED's lag behind BLS and DOL is unmeasured: check /calendar?debug=1 on the first release. Memory only (no KV): one request per series (17 for a full poll).
const OFF_SLOW = 3 * 3600e3, OFF_FAST = 60000, OFF_RETRY = 3 * 60000;   // the full 17-series download every 3 h (was 30 min): a finished release does not change, and a release window has its own 60 s tier below
const offState = { M: null, at: 0, fastAt: 0, failAt: 0, err: null, status: 'none', inflight: null, via: null };
const redact = s => String(s).replace(/api_key=[^&\s]*/gi, 'api_key=***');
// The API call says who it is (FRED's terms ask programs to identify themselves) and, when it fails, keeps what FRED answered: status, server and the start of the body.
// A 520 from a plain `get` tells nothing; the body and headers show whether it is a block, a bad key or an outage.
async function fredApiGet(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'market-dashboard/1.0 (personal dashboard; +https://jtradeats.github.io)', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  const text = await r.text();
  if (!r.ok) {
    const snip = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`HTTP ${r.status} from ${new URL(url).host} [server=${r.headers.get('server') || '?'}${r.headers.get('cf-ray') ? ' cf-ray=' + r.headers.get('cf-ray') : ''}] ${snip}`);
  }
  return text;
}
// `only`: a Set of series to fetch (the ones a release in the next minutes needs); omitted = every series. A partial fetch is merged into what is held.
async function loadOfficial(env, only) {
  const since = new Date(Date.now() - 460 * 864e5).toISOString().slice(0, 10);   // 13+ months: year-on-year needs it
  const key = env && env.FRED_KEY, eiaKey = env && env.EIA_KEY, M = {}, errs = [];
  await Promise.all(OFF_SERIES.filter(s => !only || only.has(s)).map(async s => {
    try {
      if (s.startsWith('EIA:')) { if (!eiaKey) throw new Error('no EIA_KEY set'); M[s] = parseEiaJson(await fredApiGet(eiaApiUrl(s.slice(4), eiaKey, since))); }   // EIA's own API (P8.33)
      else M[s] = key ? parseFredJson(await fredApiGet(fredApiUrl(s, key, since))) : parseFredCsv(await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s}&cosd=${since}`));
      if (!M[s].size) throw new Error('no rows');
    } catch (e) { delete M[s]; errs.push([s, redact(e.message)]); }
  }));
  // the same failure for every series is shown once, not once per series
  const text = errs.length > 1 && errs.every(([, m]) => m === errs[0][1]) ? [`${errs.length} series: ${errs[0][1]}`] : errs.map(([s, m]) => `${s}: ${m}`);
  if (!Object.keys(M).length) throw new Error((key ? '' : 'no FRED_KEY set (the keyless CSV is usually refused): ') + text.join(' | '));
  return { M, errs: text, via: key ? 'api' : 'csv' };
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
    if (fullDue) { offState.M = o.M; offState.at = Date.now(); } else { offState.M = { ...offState.M, ...o.M }; offState.fastAt = Date.now(); }
    offState.failAt = 0; offState.err = o.errs.length ? o.errs.join(' | ').slice(0, 320) : null; offState.status = 'ok'; offState.via = o.via;
  } catch (e) {
    offState.failAt = Date.now(); offState.err = redact(e.message).slice(0, 320);
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
  return { d1: !!(env && env.DB), feeds_run_age_s: age('feeds_run'), feeds_ok_age_s: age('feeds_ok'), calendar_age_s: age('cal'), calendar_near_age_s: age('cal_near'), posts: p, error: postsError() };
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
}
async function pollCalendar(env, ctx, at) {
  await loadSync(env);
  const sch = schedule(at), min = Math.floor(at / 60000);
  const near = sch.events.some(e => e && !e.hol && e.src !== 'feed' && Number.isFinite(e.t) && e.t <= at + CAL_NEAR[0] && e.t >= at - CAL_NEAR[1]);
  if (!near && min % 10 !== 0) return;
  await getCalendar(env, ctx, {});
  await beat(env, near ? 'cal_near' : 'cal', Date.now());
}
const SYNC_RELOAD = 5 * 60000, LAZY_GAP = 10 * 60000, LAZY_GAP_NEVER = 60000, SYNC_TIMEOUT = 8000;
const SYNC_TIMEOUT_TREASURY = 25000;   // TreasuryDirect's "announced" lookups (the only treasurydirect.gov calls) timed out at 8 s and again at 15 s. runTreasury runs them beside the tentative-file reads, so a run is about 25 s at worst: inside the 30 s a background (waitUntil) run is allowed
const syncState = { rec: null, at: 0, running: false, tried: {}, last: null };
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

// Fair Economy (two weeks) and, with the FMP_KEY secret, FMP (35 days), lowest priority first. A provider that fails is reported, never thrown.
async function gatherProvider(env) {
  const feeds = [], clean = e => String(e.message).replace(/apikey=[^&\s]*/gi, 'apikey=***').slice(0, 100);
  try {   // the calendar's shared copy (memory, then KV, with its own 429 back-off): the sync never makes a second direct ask of Fair Economy, which is what kept hitting HTTP 429
    await refreshFeed(env);
    if (!feedState.events || Date.now() - feedState.at > CAL_USE_MAX) throw new Error(feedState.err || 'no recent Fair Economy copy');
    feeds.push({ name: 'Fair Economy', rows: feedState.events });
  } catch (e) { feeds.push({ name: 'Fair Economy', rows: [], err: clean(e) }); }
  if (env && env.FMP_KEY) { try { feeds.push({ name: 'FMP', rows: await loadFmp(env) }); } catch (e) { feeds.push({ name: 'FMP', rows: [], err: clean(e) }); } }
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
  const rec = syncState.rec, due = dueSources(rec, now, !!(env && env.FMP_KEY));
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
    schedCache.eff = { ...SCHEDULE, releases: m.releases, checked: m.checked };
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

let calMemo = null;   // { at, debug, body }: the page asks every 15-20 s around a release, so keep the answer for 10 s
async function getCalendar(env, ctx, opts = {}) {
  const now = Date.now(), debug = !!opts.debug;
  if (calMemo && calMemo.debug === debug && now - calMemo.at < 10000) return calMemo.body;
  await Promise.all([loadSync(env), firstSeed(env), ledgerSeed(env)]);
  const sch = schedule(now);
  syncLazy(env, ctx, now);   // an overdue sync source starts in the background (D77)
  const pw = wireSeed(env).then(() => feedWindow(env, ctx, 'FinancialJuice', wireHot(sch.events, now)))
    .catch(e => { wireSt.err = String(e.message).slice(0, 120); return { posts: [], status: 'broken' }; });   // polls Telegram only around a covered release
  const ffFast = ffHot(sch.events, now);   // a scheduled release is about to happen or just happened
  const p = Promise.all([feedRefresh(env, ctx, ffFast), fmpRefresh(env, ctx, sch), offRefresh(env, ctx, sch)]);
  if (!feedState.events && !fmpState.events && !offState.M) await Promise.race([p, new Promise(r => setTimeout(r, CAL_WAIT))]);   // cold start: give the providers a moment, never longer

  const [lo, hi] = CAL_WINDOW;
  const base = sch.events.filter(e => e.t >= now + lo && e.t <= now + hi);
  const feeds = [];
  if (feedState.events && now - feedState.at < CAL_USE_MAX) feeds.push({ name: 'Fair Economy', rows: feedState.events });
  if (fmpState.events && now - fmpState.at < CAL_USE_MAX) feeds.push({ name: 'FMP', rows: fmpState.events });
  const o = overlay(base, feeds, INDICATORS, now);
  const nRes = applyResults(o.events, RESULTS);
  const fw = await pw, wr = applyWire(o.events, fw.posts, now, wireSt.memo);   // blanks only; typed numbers (above) and provider numbers win
  if (wr.changed) wireSt.dirty = true;
  wireSt.feed = fw.status; if (fw.status !== 'broken') wireSt.err = null;
  o.issues.push(...wr.issues);
  if (recordPrev(firstSt.mem, o.events, now)) firstSt.dirty = true;   // the previous as the feeds and the wire show it: still before any revision
  const off = offState.M && now - offState.at < CAL_USE_MAX ? applyOfficial(o.events, offState.M, now, firstLookups(firstSt.mem)) : { n: 0, issues: [] };   // fills blanks, replaces typed placeholders, flags disagreements
  if (recordActual(firstSt.mem, o.events, now)) firstSt.dirty = true;
  if (firstSt.dirty && pruneFirst(firstSt.mem, now)) firstSt.dirty = true;
  ledgerSt.restored = applyLedger(o.events, ledgerSt.mem, now);   // what the live sources lost (a cold start, a lapse) comes back from the ledger, with its original tag
  if (recordLedger(ledgerSt.mem, o.events, now)) ledgerSt.dirty = true;
  if (ledgerSt.dirty) pruneLedger(ledgerSt.mem, now);
  o.issues.push(...off.issues);
  if (off.wire && off.wire.length && recordConfirms(wireSt.memo, off.wire, now)) wireSt.dirty = true;   // wire against official: the agree and disagree log
  const sv = wireSave(env, now); if (ctx) ctx.waitUntil(sv);
  const fv = firstSave(env, now); if (ctx) ctx.waitUntil(fv);
  const lv = ledgerSave(env, now); if (ctx) ctx.waitUntil(lv);
  o.issues.push(...sch.merged.issues, ...syncIssues(syncState.rec, now, INDICATORS, !!(env && env.FMP_KEY)));   // schedule sync: failures, overdue sources, dates that moved overnight
  chainPrevious(o.events);
  const repl = typedReplaced(o.events, RESULTS);   // typed placeholders a real source has replaced: safe to delete from results.json

  let fstat = feedState.status;
  if (feedState.events && ffStale(now - feedState.at, ffFast)) fstat = 'stale';
  else if (fstat === 'none' && feedState.failAt) fstat = 'unavailable';
  let mstat = fmpState.status;
  if (mstat === 'ok' && now - fmpState.at > FMP_SLOW * 2) mstat = 'stale';

  let ostat = offState.status;
  if (ostat === 'ok' && now - offState.at > OFF_SLOW * 2) ostat = 'stale';
  const a = sch.aud, all = o.issues.concat(a.issues);
  const status = a.status === 'error' || o.issues.some(i => i.lvl === 'error') ? 'error' : (a.status === 'check' || o.issues.length) ? 'check' : 'ok';
  const out = {
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    now,                                                  // the page compares this with its own clock
    src: 'official release schedule',
    sources: SCHEDULE.sources, checked: sch.checked, kinds: KINDS_PUBLIC, fams: INDICATORS.fams, backdrop: INDICATORS.backdrop,   // what the page needs to explain each release
    feed: { status: fstat, mode: ffFast ? 'release window (5 min, this week only)' : 'normal (30 min)', at: feedState.at || null, matched: o.matched, extras: o.extras, error: fstat === 'ok' ? null : feedState.err },
    fmp: { status: mstat, at: fmpState.at || null, error: mstat === 'ok' ? null : fmpState.err },
    official: { status: ostat, via: offState.via, at: offState.at || null, n: off.n, error: ostat === 'ok' ? null : offState.err },
    ledger: { rows: Object.keys(ledgerSt.mem.rows).length, restored: ledgerSt.restored },   // restored: fields put back this time because a live source had none or a lesser one
    results: { asof: RESULTS.asof || null, n: nRes, replaced: repl.length, first: Object.keys(firstSt.mem.rows).length },
    wire: { status: fw.status, n: wr.n, error: wireSt.err, ...wireSummary(wireSt.memo) },   // FinancialJuice actuals filled this time, and how often the wire matched the official number so far
    sync: { ...syncSummary(syncState.rec), tiers: sch.merged.tiers, stats: sch.merged.stats },   // what the schedule check shows
    audit: { status, nIssues: a.nIssues + o.issues.length, counts: a.counts, total: a.total, first: a.first, horizon: a.horizon,
      checked: a.checked, issues: all.slice(0, 25) },
    events: o.events,
  };
  if (debug) out.debug = { replaced: repl.slice(0, 40), first: Object.fromEntries(Object.entries(firstSt.mem.rows).slice(-40)), fair: { n: (feedState.events || []).length, sample: (feedState.events || []).slice(0, 3) },
    fmp: { n: (fmpState.events || []).length, rawSample: fmpState.sample, withActual: fmpState.nAct },
    official: { via: offState.via, error: offState.err, series: Object.fromEntries(Object.entries(offState.M || {}).map(([k, m]) => { const d = [...m.keys()].sort().pop(); return [k, { rows: m.size, lastObs: d, last: m.get(d) }]; })) }, unmatched: o.unmatched,
    wire: { feed: fw.status, window: fw.posts.length, newest: fw.posts[0] ? fw.posts[0].t : null, unmatchedMacro: wr.unmatched, rows: wireSt.memo.rows } };
  const body = JSON.stringify(out);
  calMemo = { at: now, debug, body };
  return body;
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
      return stale ? { ...c.val, stale: true } : c.val;
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
      const { stale, ...val } = it;
      itemCache.set(it.label, { val, at: val.f || 0, ttl: 0 });   // last good value + roll history; refetched at once
    }
    if (snap.fng && !fngState.val) { fngState.val = snap.fng; fngState.at = 0; }
    const at = Date.parse(snap.updated);
    if (!memo && at) memo = { at, body: JSON.stringify(snap) };
  } catch (e) { /* KV unavailable: carry on without it */ }
}

function refresh(env, ctx) {
  if (!inflight) {
    inflight = build(ctx, env).then(async b => {
      const body = JSON.stringify(b);
      memo = { at: Date.now(), body };
      if (env && env.MARKET_KV && Date.now() - lastKvWrite > KV_GAP) {
        lastKvWrite = Date.now();
        try { await env.MARKET_KV.put(KV_KEY, body); } catch (e) { /* ignore */ }
      }
      return body;
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

async function getMarket(env, ctx) {
  if (!seeded) await seed(env);
  const age = memo ? Date.now() - memo.at : Infinity;
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(req.url);
    const json = { ...cors, 'Content-Type': 'application/json; charset=utf-8' };   // charset so a browser's raw JSON view does not show UTF-8 text as â€™ and ðŸ”¸
    if (pathname === '/health') {
      await loadSync(env);
      return new Response(JSON.stringify({
        ok: true, kv: !!(env && env.MARKET_KV),
        memo_age_s: memo ? Math.round((Date.now() - memo.at) / 1000) : null,
        cached_items: itemCache.size,
        calendar: { audit: schedule(Date.now()).aud.status, feed: feedState.status, feed_age_s: feedState.at ? Math.round((Date.now() - feedState.at) / 1000) : null,
          fmp: fmpState.status, fmp_age_s: fmpState.at ? Math.round((Date.now() - fmpState.at) / 1000) : null,
          official: offState.status, official_age_s: offState.at ? Math.round((Date.now() - offState.at) / 1000) : null,
          wire: wireSt.memo ? { feed: wireSt.feed, ...wireSummary(wireSt.memo) } : null },
        tv: tvHealth(await loadTv(env), env),
        sectors: sectors.health(), weekly: weekly.health(),
        curve: { asof: curve.memo ? curve.memo.asof : null, age_s: curve.memo && curve.memo.at ? Math.round((Date.now() - curve.memo.at) / 1000) : null, check: curve.memo ? curve.memo.check : null, error: curve.err },
        sync: syncHealth(),
        poller: await pollerHealth(env),
        wire: { ...feedHealth(), channels: Object.fromEntries(Object.keys(CHANNELS).map(n => [n, feedHealth(Date.now(), n)])) },   // the DeItaone fields as before, plus every channel; FinancialJuice "hot" = flagged posts in the window
      }), { headers: json });
    }
    if (pathname === '/ingest') {   // TradingView webhook target (src/tv.js); the secret travels in the JSON body because TradingView cannot set headers
      if (req.method !== 'POST') return new Response('{"error":"POST only"}', { status: 405, headers: json });
      const r = await tvIngest(req, env, TV_LABELS);
      return new Response(JSON.stringify(r.out), { status: r.status, headers: { ...json, 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/tv') {   // read only: what the last push held and whether it still counts as live
      return new Response(JSON.stringify(tvHealth(await loadTv(env), env)), { headers: { ...json, 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/market') {
      try {
        let out = await getMarket(env, ctx);
        if (!(env && env.TV_OVERLAY === 'off')) out = tvMarket(out, await loadTv(env), Date.now(), quote);   // live futures at response time, not at build time (src/tv.js)
        return new Response(out, { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/calendar') {
      try {
        return new Response(await getCalendar(env, ctx, { debug: new URL(req.url).searchParams.has('debug') }), { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/sectors' || pathname === '/weekly') {
      try {
        const route = pathname === '/sectors' ? sectors : weekly, fresh = new URL(req.url).searchParams.has('fresh');
        if (route === weekly && !seeded) await seed(env);   // load the tape's last snapshot first: its roll flags feed the week-open check
        let out = await route.get(env, ctx, { fresh });
        if (!(env && env.TV_OVERLAY === 'off')) out = route === weekly
          ? tvWeekly(out, await loadTv(env), Date.now(), TV_WEEKLY)   // live price and week open from the TradingView push, when fresh (src/tv.js)
          : tvMarket(out, await loadTv(env), Date.now(), quote);      // live sector ETFs, each only while its own bar is recent (P8.28)
        return new Response(out, { headers: { ...json, 'Cache-Control': fresh ? 'no-store' : 'public, max-age=20' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/curve') {
      try {
        return new Response(await getCurve(env, ctx), { headers: { ...json, 'Cache-Control': 'public, max-age=60' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    if (pathname === '/sync') {   // read only: the state of the schedule sync (add ?debug=1 for the samples kept when a source could not be read)
      await loadSync(env, true);
      const now = Date.now(), rec = syncState.rec, m = schedule(now).merged;
      const body = { now, crons: SYNC_CRONS, running: syncState.running, lastRun: syncState.last, ...syncSummary(rec), tiers: m.tiers, stats: m.stats,
        issues: syncIssues(rec, now, INDICATORS, !!(env && env.FMP_KEY)).concat(m.issues) };
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
        const body = channel ? await getFeed(env, ctx, { debug, channel }) : await getFeeds(env, ctx, { debug });
        return new Response(body, { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
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