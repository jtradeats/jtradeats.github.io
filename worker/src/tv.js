// TradingView push layer: live CME futures prices for the tape.
// One Pine alert (tv_push.pine) posts all prices as JSON to POST /ingest about once a minute.
// The latest push is kept as ONE row in D1 (about 1,440 row writes a day), and /market lays it over the Yahoo values.
// Yahoo stays the fallback and still supplies the contract name, so ROLLED detection is unchanged.
// v2: the same push can carry each future's week open (w), so the /weekly card can run on one source for both numbers.
// v3 (plan P8.28): the push also carries the non-futures tape items TradingView streams in real time (yields, DXY, MOVE, USDJPY, bond and sector ETFs).
// A future trades round the clock and the alert's own lag tells whether its feed is delayed; the others go quiet when their market shuts, so each of
// those travels with its own last bar time (third value) and is used only while that bar is recent. A late one is listed in `late`, never shown as live.

export const TV_SCHEMA = 'CREATE TABLE IF NOT EXISTS tv_latest (id INTEGER PRIMARY KEY, body TEXT NOT NULL, f INTEGER NOT NULL)';
export const TV_STALE_MS = 150000;     // no push for 2.5 min (the alert fires every 60 s, so two missed): fall back to Yahoo
export const TV_MAX_LAG_MS = 120000;   // alert fired more than 2 min after its bar closed: the feed is delayed, never call it live
const TV_MAX_BODY = 4096;
const TV_MAX_TS_SKEW = 10 * 60000;     // the alert's own clock may differ from ours by this much at most
const TV_MAX_MOVE = 0.30;              // one symbol more than 30% from its prior close is dropped as garbage (that symbol only)
const TV_BAR_MAX = { etf: 10 * 60000, other: 3 * 60000 };   // newest bar a non-future may rest on: an ETF can go minutes between trades, the rest tick every few seconds
const TV_MAX_YIELD = 25;               // a yield above 25 % is the x10 quirk (^TNX style) or garbage: refused, not rescaled
const TV_WEEK_MAX_AGE = 8 * 86400000;  // a week open older than 8 days is not this week's
const TV_READ_MEMO = 10000;            // /market builds at most every 30 s, so a 10 s memo of the D1 row is plenty

function same(a, b) {                  // constant-time string compare
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

// POST /ingest. Returns { status, out }; never throws.
// labels: a Set of tape-future labels (v1/v2 callers), or a Map of label -> kind ('fut', 'idx', 'fx', 'yield', 'etf'). Any kind but 'fut' must carry a bar time.
export async function tvIngest(req, env, labels, now = Date.now()) {
  try {
    if (!env || !env.TV_SECRET) return { status: 503, out: { error: 'TV_SECRET is not set on the Worker' } };
    if (!env.DB) return { status: 503, out: { error: 'D1 binding DB is missing' } };
    const text = await req.text();
    if (text.length > TV_MAX_BODY) return { status: 413, out: { error: 'body too large' } };
    let j;
    try { j = JSON.parse(text); } catch (e) { return { status: 400, out: { error: 'body is not JSON' } }; }
    if (!j || typeof j !== 'object' || !same(j.s ?? '', env.TV_SECRET)) {
      console.log('ingest: rejected, bad or missing secret');
      return { status: 401, out: { error: 'unauthorised' } };
    }
    if (j.v !== 1) return { status: 400, out: { error: 'unknown payload version' } };
    const ts = num(j.ts), lag = num(j.lag);
    if (ts === null || lag === null) return { status: 400, out: { error: 'ts and lag must be numbers' } };
    if (Math.abs(now - ts) > TV_MAX_TS_SKEW) return { status: 400, out: { error: `ts is ${Math.round((now - ts) / 1000)} s away from the Worker clock` } };
    if (!j.q || typeof j.q !== 'object') return { status: 400, out: { error: 'q (the prices) is missing' } };

    const q = {}, rej = [], late = [];
    const kindOf = label => (typeof labels.get === 'function' ? labels.get(label) : 'fut') || 'fut';
    for (const [label, arr] of Object.entries(j.q)) {
      if (!labels.has(label)) { rej.push(`${label}: not a pushable tape item`); continue; }
      const p = Array.isArray(arr) ? num(arr[0]) : null;
      const pv = Array.isArray(arr) && arr[1] != null ? num(arr[1]) : null;
      if (p === null || p <= 0) { rej.push(`${label}: bad price`); continue; }
      if (arr[1] != null && (pv === null || pv <= 0)) { rej.push(`${label}: bad prior close`); continue; }
      if (pv && Math.abs(p / pv - 1) > TV_MAX_MOVE) { rej.push(`${label}: ${p} is over ${TV_MAX_MOVE * 100}% from ${pv}`); continue; }
      const kind = kindOf(label);
      if (kind !== 'fut') {   // not a round-the-clock future: it must prove its own bar is recent
        const bt = num(arr[2]);
        if (bt === null) { rej.push(`${label}: needs its bar time (ms) as the third value`); continue; }
        if (bt > ts + 60000) { rej.push(`${label}: bar time is in the future`); continue; }
        if (kind === 'yield' && p > TV_MAX_YIELD) { rej.push(`${label}: ${p} is too big for a yield (send it in percent)`); continue; }
        if (ts - bt > (kind === 'etf' ? TV_BAR_MAX.etf : TV_BAR_MAX.other)) { late.push(label); continue; }
      }
      q[label] = [p, pv];
    }
    const n = Object.keys(q).length;
    if (!n && !late.length) return { status: 400, out: { error: 'no usable prices', rejected: rej } };

    // Optional week opens: { "NQ1!": [open price, open time in ms] }. A bad entry drops that symbol's week open only.
    const w = {};
    if (j.w && typeof j.w === 'object') {
      for (const [label, arr] of Object.entries(j.w)) {
        const o = Array.isArray(arr) ? num(arr[0]) : null, ot = Array.isArray(arr) ? num(arr[1]) : null;
        if (!labels.has(label)) { rej.push(`w ${label}: not a tape future`); continue; }
        if (o === null || o <= 0 || ot === null) { rej.push(`w ${label}: bad week open`); continue; }
        if (ot > now + 60000 || now - ot > TV_WEEK_MAX_AGE) { rej.push(`w ${label}: week open time is not this week`); continue; }
        if (q[label] && Math.abs(q[label][0] / o - 1) > TV_MAX_MOVE) { rej.push(`w ${label}: ${o} is over ${TV_MAX_MOVE * 100}% from the price`); continue; }
        w[label] = [o, ot];
      }
    }

    const body = JSON.stringify({ f: now, ts, lag, q, w, rej, late });
    await env.DB.prepare('INSERT INTO tv_latest (id, body, f) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET body = excluded.body, f = excluded.f')
      .bind(body, now).run();
    console.log(`ingest ok: n=${n} late=${late.length} weekopens=${Object.keys(w).length} lag=${lag} ms rejected=${rej.length}${rej.length ? ' ' + rej.join('; ') : ''}`);
    return { status: 200, out: { ok: true, n, late, week_opens: Object.keys(w).length, lag_ms: lag, rejected: rej } };
  } catch (e) {
    console.log('ingest error: ' + String(e && e.message));
    return { status: 500, out: { error: 'ingest failed: ' + String(e && e.message).slice(0, 160) } };
  }
}

// The latest push, or null. A D1 failure never breaks /market: it returns null and notes the error for /health.
const state = { at: 0, v: null, err: null };
export async function loadTv(env, now = Date.now()) {
  if (!env || !env.DB) { state.err = 'no D1 binding'; return null; }
  if (now - state.at < TV_READ_MEMO) return state.v;
  try {
    const r = await env.DB.prepare('SELECT body FROM tv_latest WHERE id = 1').first();
    state.v = r ? JSON.parse(r.body) : null;
    state.err = null;
  } catch (e) { state.v = null; state.err = String(e && e.message).slice(0, 120); }
  state.at = now;
  return state.v;
}

// Lays a pushed price over one tape item. Keeps everything else on the item (contract name, rolledAt, kind, label).
// `quote` is index.js's own helper, so rounding and the change maths stay in one place.
export function tvOverlay(it, tv, now, quote) {
  const q = tv && tv.q && tv.q[it.label];
  if (!q) return it;
  if (now - tv.f > TV_STALE_MS || tv.lag > TV_MAX_LAG_MS) return it;
  const { c, pc, stale, cls, ...base } = it;   // the old change was measured against another source's prior close and cls 'prior' marked an end-of-day value: drop both, recompute from TradingView's
  const o = { ...base, ...quote(q[0], q[1], tv.ts), src: 'tv', f: tv.f, live: true, lag_ms: tv.lag };
  if (it.kind === 'yield') delete o.pc;   // a percent change of a yield means nothing: the page shows the point change (same rule as the Yahoo path)
  return o;
}

// Lays the pushed price and the pushed week open over the /weekly card. `body` is the route's JSON string; `map` is weekly label -> tape label
// (from symbols.json "roll"). An item is replaced only when: the push is fresh and not delayed, both numbers are present, and the
// Yahoo side did not flag a contract change this week (rolled). Anything else is left exactly as weekly.js produced it.
export function tvWeekly(body, tv, now, map) {
  if (!tv || !tv.q || !tv.w || now - tv.f > TV_STALE_MS || tv.lag > TV_MAX_LAG_MS) return body;
  let j;
  try { j = JSON.parse(body); } catch (e) { return body; }
  if (!j || !Array.isArray(j.items)) return body;
  let hit = 0;
  j.items = j.items.map(it => {
    const tl = map[it.label], q = tl && tv.q[tl], w = tl && tv.w[tl];
    if (!q || !w || it.rolled) return it;
    const { late, flag, was, stale, ...base } = it;
    const c = +(q[0] - w[0]).toFixed(4), pc = +((q[0] - w[0]) / w[0] * 100).toFixed(3);
    hit++;
    return { ...base, p: +q[0].toFixed(4), open: w[0], ot: w[1], c, pc, t: tv.ts, f: tv.f, src: 'tv', live: true, lag_ms: tv.lag };
  });
  return hit ? JSON.stringify(j) : body;
}

// Lays the pushed prices over the /market body at response time, so the tape never waits for the memoised build (up to 30 s old, plus one poll behind).
// Same freshness rules as tvOverlay; an item is touched only when the push is fresh, not delayed, and covers its label. Anything else is returned exactly as built.
export function tvMarket(body, tv, now, quote) {
  if (!tv || !tv.q || now - tv.f > TV_STALE_MS || tv.lag > TV_MAX_LAG_MS) return body;
  let j;
  try { j = JSON.parse(body); } catch (e) { return body; }
  if (!j || !Array.isArray(j.items)) return body;
  let hit = 0;
  j.items = j.items.map(it => { const o = tvOverlay(it, tv, now, quote); if (o !== it) hit++; return o; });
  return hit ? JSON.stringify(j) : body;
}

export function tvHealth(tv, env, now = Date.now()) {
  return {
    secret: !!(env && env.TV_SECRET), d1: !!(env && env.DB), overlay: !(env && env.TV_OVERLAY === 'off'),
    push_age_s: tv ? Math.round((now - tv.f) / 1000) : null,
    lag_ms: tv ? tv.lag : null,
    live: tv ? (now - tv.f <= TV_STALE_MS && tv.lag <= TV_MAX_LAG_MS) : false,
    symbols: tv ? Object.keys(tv.q) : [],
    week_opens: tv && tv.w ? Object.keys(tv.w) : [],
    rejected: tv ? tv.rej : [],
    late: tv && tv.late ? tv.late : [],   // pushed, but resting on an old bar (market shut or feed delayed): shown from the normal feed instead
    error: state.err,
  };
}
