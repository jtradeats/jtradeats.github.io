// Market Dashboard Worker: primary data path for news.html (JS port of dashboard_data.py).
// GET /market -> JSON for the page. GET /feed -> DeItaone wire posts. GET /calendar -> release schedule with forecast/previous/actual (?debug=1 shows provider samples and unmatched titles). GET /health -> small status object.
// No API keys needed. Optional KV binding named MARKET_KV keeps a snapshot across cold starts.

import SYMBOLS from '../config/symbols.json';
import SCHEDULE from '../config/schedule.json';
import INDICATORS from '../config/indicators.json';
import RESULTS from '../config/results.json';
import { etToMs, expand, audit, overlay, normFair, normFmp, applyResults, chainPrevious } from './schedule.js';
import { getFeed, feedHealth } from './feed.js';   // DeItaone wire via the Telegram mirror (plan 1.5)

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

async function qFred(series) {
  // cosd limits the CSV to recent rows; the full history is ~17k rows and would blow the CPU limit
  const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const text = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${since}`);
  const vals = text.trim().split(/\r?\n/).slice(1).map(l => l.split(','))
    .filter(r => r.length > 1 && r[1].trim() !== '' && r[1].trim() !== '.')
    .map(r => [r[0], Number(r[1])]);
  const [d1, v1] = vals[vals.length - 1];
  const v0 = vals[vals.length - 2][1];
  return quote(v1, v0, Date.parse(d1 + 'T00:00:00Z'));
}

async function loadTreasury(year) {
  const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/' +
    `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const lines = (await get(url)).trim().split(/\r?\n/);
  const clean = s => s.replace(/"/g, '').trim();
  const head = lines[0].split(',').map(clean);
  return lines.slice(1).map(l => {
    const c = l.split(',').map(clean), o = {};
    head.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
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

const SOURCES = { yahoo: qYahoo, cboe: qCboe, fred: qFred, treasury: qTreasury };

// [label, kind, [[source, symbol], ...] tried in order]. USD20Y dropped (decision D2).
// dashboard_data.py only knows the original 13 items; it is not extended (Action retires in plan 2.3).
const ITEMS = SYMBOLS.items.map(i => [i.label, i.kind, i.chain]);   // source of truth: worker/config/symbols.json
const META = Object.fromEntries(SYMBOLS.items.map(i => [i.label, { grp: i.group, row: i.row }]));   // tape placement, passed to the page

function fixYield(q) {
  if (q.p > 25) for (const k of ['p', 'c']) if (k in q) q[k] = +(q[k] / 10).toFixed(4); // x10 quirk
  delete q.pc; // % change of a yield isn't meaningful; the page shows the point change
  return q;
}

// ---- per-item cache: last good value + when it was fetched + how long it stays fresh ----
const itemCache = new Map(); // label -> { val, at, ttl, failAt }

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
      itemCache.set(label, { val: got, at: Date.now(), ttl: TTL_BY_SRC[src] });
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
  const attempts = [[CNN, CNN_HEADERS], [`${CNN}/${since}`, CNN_HEADERS], [CNN, {}]];
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
//   3. worker/config/results.json: numbers typed in by hand. They win for the fields they define.
// A failure in any layer leaves the schedule untouched and only changes the status fields.
const CAL_FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
const CAL_TTL = 30 * 60000;          // one upstream round per 30 min
const CAL_RETRY = 5 * 60000;         // after a failure
const CAL_RETRY_429 = 15 * 60000;    // after a 429, leave the feed alone for longer
const CAL_USE_MAX = 12 * 3600e3;     // never lay a feed copy older than this over the schedule
const CAL_WAIT = 1200;               // a first request waits at most this long for the providers, then answers without them
const CAL_WINDOW = [-31 * 864e5, 60 * 864e5];   // "this month" and "yesterday" need the past, "next week" the future
const CAL_KEY = 'calendar:last';
const feedState = { events: null, at: 0, failAt: 0, err: null, status: 'none', inflight: null };

async function loadFeed() {
  const notes = [], raw = [];
  let ok = 0, rate = false;
  await Promise.all(CAL_FEEDS.map(async u => {
    try { raw.push(...JSON.parse(await get(u, { Accept: 'application/json' }))); ok++; }
    catch (e) { if (/HTTP 429/.test(e.message)) rate = true; notes.push(`${u.split('/').pop()}: ${e.message}`); }   // next week's file may not exist yet
  }));
  if (!ok) { const err = new Error(notes.join(' | ')); err.rate = rate; throw err; }
  return { events: normFair(raw), notes };
}

// Bring the Fair Economy copy up to date if it is due. Never throws; records the outcome in feedState.
async function refreshFeed(env) {
  const now = Date.now();
  if (feedState.events && now - feedState.at < CAL_TTL) return;
  // every isolate would otherwise ask the feed on its own, so share one good copy through KV
  if (env && env.MARKET_KV) {
    try {
      const sn = await env.MARKET_KV.get(CAL_KEY, 'json');
      if (sn && sn.events && sn.at > feedState.at) { feedState.events = sn.events; feedState.at = sn.at; feedState.status = 'ok'; }
    } catch (e) { /* KV unavailable: carry on */ }
    if (feedState.events && Date.now() - feedState.at < CAL_TTL) return;
  }
  if (feedState.failAt && now - feedState.failAt < (feedState.rate ? CAL_RETRY_429 : CAL_RETRY)) return;
  try {
    const f = await loadFeed();
    feedState.events = f.events; feedState.at = Date.now(); feedState.failAt = 0; feedState.err = null; feedState.rate = false; feedState.status = 'ok';
    if (env && env.MARKET_KV) { try { await env.MARKET_KV.put(CAL_KEY, JSON.stringify({ at: feedState.at, events: f.events })); } catch (e) { /* ignore */ } }
  } catch (e) {
    feedState.failAt = Date.now(); feedState.err = String(e.message).slice(0, 200); feedState.rate = !!e.rate;
    feedState.status = e.rate ? 'rate-limited' : 'unavailable';
  }
}
function feedRefresh(env, ctx) {
  if (!feedState.inflight) {
    feedState.inflight = refreshFeed(env).finally(() => { feedState.inflight = null; });
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

// The expanded schedule and its audit are cheap but not free (10 ms CPU limit): keep them for a while
// kinds without the provider-title patterns (those are only for the Worker's matching)
const KINDS_PUBLIC = Object.fromEntries(Object.entries(INDICATORS.kinds).map(([k, v]) => {
  const { match, rows, ...rest } = v;
  return [k, { ...rest, rows: (rows || []).map(({ match: m, ...r }) => r) }];
}));
const schedCache = { events: null, aud: null, at: 0 };
function schedule(now) {
  if (!schedCache.events) schedCache.events = expand(SCHEDULE, INDICATORS);
  if (!schedCache.aud || now - schedCache.at > 10 * 60000) { schedCache.aud = audit(SCHEDULE, INDICATORS, now); schedCache.at = now; }
  return schedCache;
}

let calMemo = null;   // { at, debug, body }: the page asks every 15-20 s around a release, so keep the answer for 10 s
async function getCalendar(env, ctx, opts = {}) {
  const now = Date.now(), debug = !!opts.debug;
  if (calMemo && calMemo.debug === debug && now - calMemo.at < 10000) return calMemo.body;
  const sch = schedule(now);
  const p = Promise.all([feedRefresh(env, ctx), fmpRefresh(env, ctx, sch)]);
  if (!feedState.events && !fmpState.events) await Promise.race([p, new Promise(r => setTimeout(r, CAL_WAIT))]);   // cold start: give the providers a moment, never longer

  const [lo, hi] = CAL_WINDOW;
  const base = sch.events.filter(e => e.t >= now + lo && e.t <= now + hi);
  const feeds = [];
  if (feedState.events && now - feedState.at < CAL_USE_MAX) feeds.push({ name: 'Fair Economy', rows: feedState.events });
  if (fmpState.events && now - fmpState.at < CAL_USE_MAX) feeds.push({ name: 'FMP', rows: fmpState.events });
  const o = overlay(base, feeds, INDICATORS, now);
  const nRes = applyResults(o.events, RESULTS);
  chainPrevious(o.events);

  let fstat = feedState.status;
  if (feedState.events && now - feedState.at > CAL_TTL * 2) fstat = 'stale';
  else if (fstat === 'none' && feedState.failAt) fstat = 'unavailable';
  let mstat = fmpState.status;
  if (mstat === 'ok' && now - fmpState.at > FMP_SLOW * 2) mstat = 'stale';

  const a = sch.aud, all = o.issues.concat(a.issues);
  const status = a.status === 'error' || o.issues.some(i => i.lvl === 'error') ? 'error' : (a.status === 'check' || o.issues.length) ? 'check' : 'ok';
  const out = {
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    now,                                                  // the page compares this with its own clock
    src: 'official release schedule',
    sources: SCHEDULE.sources, checked: SCHEDULE.checked, kinds: KINDS_PUBLIC, fams: INDICATORS.fams, backdrop: INDICATORS.backdrop,   // what the page needs to explain each release
    feed: { status: fstat, at: feedState.at || null, matched: o.matched, extras: o.extras, error: fstat === 'ok' ? null : feedState.err },
    fmp: { status: mstat, at: fmpState.at || null, error: mstat === 'ok' ? null : fmpState.err },
    results: { asof: RESULTS.asof || null, n: nRes },
    audit: { status, nIssues: a.nIssues + o.issues.length, counts: a.counts, total: a.total, first: a.first, horizon: a.horizon,
      checked: a.checked, issues: all.slice(0, 25) },
    events: o.events,
  };
  if (debug) out.debug = { fair: { n: (feedState.events || []).length, sample: (feedState.events || []).slice(0, 3) },
    fmp: { n: (fmpState.events || []).length, rawSample: fmpState.sample, withActual: fmpState.nAct }, unmatched: o.unmatched };
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

async function build(ctx) {
  const log = [], notes = [];
  const work = Promise.all([...ITEMS.map(([l, k, c]) => getItem(l, k, c, log, notes)), getFng()]);
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
      const stale = (c.failAt && c.failAt > c.at) || now - c.at > c.ttl + 60000;
      return stale ? { ...c.val, stale: true } : c.val;
    }
    return prevItems[label] ? { ...prevItems[label], stale: true } : { label, kind, p: null };
  }).map(it => ({ ...it, ...META[it.label] }));

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
    inflight = build(ctx).then(async b => {
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
    const json = { ...cors, 'Content-Type': 'application/json' };
    if (pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true, kv: !!(env && env.MARKET_KV),
        memo_age_s: memo ? Math.round((Date.now() - memo.at) / 1000) : null,
        cached_items: itemCache.size,
        calendar: { audit: schedule(Date.now()).aud.status, feed: feedState.status, feed_age_s: feedState.at ? Math.round((Date.now() - feedState.at) / 1000) : null,
          fmp: fmpState.status, fmp_age_s: fmpState.at ? Math.round((Date.now() - fmpState.at) / 1000) : null },
        wire: feedHealth(),
      }), { headers: json });
    }
    if (pathname === '/market') {
      try {
        return new Response(await getMarket(env, ctx), { headers: { ...json, 'Cache-Control': 'public, max-age=20' } });
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
    if (pathname === '/feed') {
      try {
        const debug = new URL(req.url).searchParams.has('debug');   // /feed?debug=1 adds a markup sample when the parser finds nothing
        return new Response(await getFeed(env, ctx, { debug }), { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    return new Response('{"error":"not found"}', { status: 404, headers: json });
  },
};
