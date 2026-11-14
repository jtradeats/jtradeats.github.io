// Market Dashboard Worker: primary data path for news.html (JS port of dashboard_data.py).
// GET /market -> JSON for the page. GET /health -> small status object.
// No API keys needed. Optional KV binding named MARKET_KV keeps a snapshot across cold starts.

import SYMBOLS from '../config/symbols.json';
import SCHEDULE from '../config/schedule.json';
import INDICATORS from '../config/indicators.json';
import { etToMs, expand, audit, overlay } from './schedule.js';

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
// The Fair Economy / Forex Factory weekly feeds are an optional extra: forecast and previous, plus an independent cross-check on dates and times.
// They are unofficial and rate-limit shared Cloudflare IPs (HTTP 429). A failure there leaves the schedule untouched.
const CAL_FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
const CAL_TTL = 30 * 60000;          // one upstream round per 30 min
const CAL_RETRY = 5 * 60000;         // after a failure
const CAL_RETRY_429 = 15 * 60000;    // after a 429, leave the feed alone for longer
const CAL_USE_MAX = 12 * 3600e3;     // never lay a feed copy older than this over the schedule
const CAL_WAIT = 1200;               // a first request waits at most this long for the feed, then answers without it
const CAL_WINDOW = [-2 * 864e5, 60 * 864e5];
const CAL_KEY = 'calendar:last';
const feedState = { events: null, at: 0, failAt: 0, err: null, status: 'none', inflight: null };

async function loadFeed() {
  const notes = [], events = [];
  let ok = 0, rate = false;
  await Promise.all(CAL_FEEDS.map(async u => {
    try {
      const rows = JSON.parse(await get(u, { Accept: 'application/json' }));
      ok++;
      for (const r of rows) {
        const t = Date.parse(r.date);
        if (r.country !== 'USD' || !t || (r.impact !== 'High' && r.impact !== 'Medium')) continue;
        events.push({ t, title: String(r.title).slice(0, 80), imp: r.impact === 'High' ? 3 : 2,
          fc: r.forecast || null, pv: r.previous || null, ac: r.actual || null });
      }
    } catch (e) { if (/HTTP 429/.test(e.message)) rate = true; notes.push(`${u.split('/').pop()}: ${e.message}`); }   // next week's file may not exist yet
  }));
  if (!ok) { const err = new Error(notes.join(' | ')); err.rate = rate; throw err; }
  events.sort((a, b) => a.t - b.t);
  return { events, notes };
}

// Bring the feed copy up to date if it is due. Never throws; records the outcome in feedState.
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

// The expanded schedule and its audit are cheap but not free (10 ms CPU limit): keep them for a while
// kinds without the feed-title patterns (those are only for the Worker's cross-check)
const KINDS_PUBLIC = Object.fromEntries(Object.entries(INDICATORS.kinds).map(([k, v]) => { const { match, ...rest } = v; return [k, rest]; }));
const schedCache = { events: null, aud: null, at: 0 };
function schedule(now) {
  if (!schedCache.events) schedCache.events = expand(SCHEDULE, INDICATORS);
  if (!schedCache.aud || now - schedCache.at > 10 * 60000) { schedCache.aud = audit(SCHEDULE, INDICATORS, now); schedCache.at = now; }
  return schedCache;
}

async function getCalendar(env, ctx) {
  const now = Date.now();
  const sch = schedule(now);
  const p = feedRefresh(env, ctx);
  if (!feedState.events) await Promise.race([p, new Promise(r => setTimeout(r, CAL_WAIT))]);   // cold start: give the feed a moment, never longer

  const fresh = feedState.events && now - feedState.at < CAL_USE_MAX;
  let events = sch.events, issues = [], fstat = feedState.status, matched = 0, extras = 0;
  if (fresh) {
    const o = overlay(sch.events, feedState.events, INDICATORS, now);
    events = o.events; issues = o.issues; matched = o.matched; extras = o.extras;
    if (now - feedState.at > CAL_TTL * 2) fstat = 'stale';
  } else if (feedState.events) fstat = 'stale';
  else if (fstat === 'none' && feedState.failAt) fstat = 'unavailable';

  const [lo, hi] = CAL_WINDOW;
  const win = events.filter(e => e.t >= now + lo && e.t <= now + hi);
  const a = sch.aud, all = issues.concat(a.issues);
  const status = a.status === 'error' || issues.some(i => i.lvl === 'error') ? 'error' : (a.status === 'check' || issues.length) ? 'check' : 'ok';
  return JSON.stringify({
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    now,                                                  // the page compares this with its own clock
    src: 'official release schedule',
    sources: SCHEDULE.sources, checked: SCHEDULE.checked, kinds: KINDS_PUBLIC,   // what the page needs to explain each release
    feed: { status: fstat, at: feedState.at || null, matched, extras, error: fstat === 'ok' ? null : feedState.err },
    audit: { status, nIssues: a.nIssues + issues.length, counts: a.counts, total: a.total, first: a.first, horizon: a.horizon,
      checked: a.checked, issues: all.slice(0, 25) },
    events: win,
  });
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
        calendar: { audit: schedule(Date.now()).aud.status, feed: feedState.status, feed_age_s: feedState.at ? Math.round((Date.now() - feedState.at) / 1000) : null },
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
        return new Response(await getCalendar(env, ctx), { headers: { ...json, 'Cache-Control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 502, headers: json });
      }
    }
    return new Response('{"error":"not found"}', { status: 404, headers: json });
  },
};
