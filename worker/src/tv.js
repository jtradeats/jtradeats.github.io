// TradingView push layer: live CME futures prices for the tape.
// One Pine alert (tv_push.pine) posts all prices as JSON to POST /ingest about once a minute.
// The latest push is kept as ONE row in D1 (about 1,440 row writes a day), and /market lays it over the Yahoo values.
// Yahoo stays the fallback and still supplies the contract name, so ROLLED detection is unchanged.

export const TV_SCHEMA = 'CREATE TABLE IF NOT EXISTS tv_latest (id INTEGER PRIMARY KEY, body TEXT NOT NULL, f INTEGER NOT NULL)';
export const TV_STALE_MS = 150000;     // no push for 2.5 min (the alert fires every 60 s, so two missed): fall back to Yahoo
export const TV_MAX_LAG_MS = 120000;   // alert fired more than 2 min after its bar closed: the feed is delayed, never call it live
const TV_MAX_BODY = 4096;
const TV_MAX_TS_SKEW = 10 * 60000;     // the alert's own clock may differ from ours by this much at most
const TV_MAX_MOVE = 0.30;              // one symbol more than 30% from its prior close is dropped as garbage (that symbol only)
const TV_READ_MEMO = 10000;            // /market builds at most every 30 s, so a 10 s memo of the D1 row is plenty

function same(a, b) {                  // constant-time string compare
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

// POST /ingest. Returns { status, out }; never throws.
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

    const q = {}, rej = [];
    for (const [label, arr] of Object.entries(j.q)) {
      if (!labels.has(label)) { rej.push(`${label}: not a tape future`); continue; }
      const p = Array.isArray(arr) ? num(arr[0]) : null;
      const pv = Array.isArray(arr) && arr[1] != null ? num(arr[1]) : null;
      if (p === null || p <= 0) { rej.push(`${label}: bad price`); continue; }
      if (arr[1] != null && (pv === null || pv <= 0)) { rej.push(`${label}: bad prior close`); continue; }
      if (pv && Math.abs(p / pv - 1) > TV_MAX_MOVE) { rej.push(`${label}: ${p} is over ${TV_MAX_MOVE * 100}% from ${pv}`); continue; }
      q[label] = [p, pv];
    }
    const n = Object.keys(q).length;
    if (!n) return { status: 400, out: { error: 'no usable prices', rejected: rej } };

    const body = JSON.stringify({ f: now, ts, lag, q, rej });
    await env.DB.prepare('INSERT INTO tv_latest (id, body, f) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET body = excluded.body, f = excluded.f')
      .bind(body, now).run();
    console.log(`ingest ok: n=${n} lag=${lag} ms rejected=${rej.length}${rej.length ? ' ' + rej.join('; ') : ''}`);
    return { status: 200, out: { ok: true, n, lag_ms: lag, rejected: rej } };
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
  const { c, pc, stale, ...base } = it;   // the Yahoo change was measured against Yahoo's prior close: drop it, recompute from TradingView's
  return { ...base, ...quote(q[0], q[1], tv.ts), src: 'tv', f: tv.f, live: true, lag_ms: tv.lag };
}

export function tvHealth(tv, env, now = Date.now()) {
  return {
    secret: !!(env && env.TV_SECRET), d1: !!(env && env.DB), overlay: !(env && env.TV_OVERLAY === 'off'),
    push_age_s: tv ? Math.round((now - tv.f) / 1000) : null,
    lag_ms: tv ? tv.lag : null,
    live: tv ? (now - tv.f <= TV_STALE_MS && tv.lag <= TV_MAX_LAG_MS) : false,
    symbols: tv ? Object.keys(tv.q) : [],
    rejected: tv ? tv.rej : [],
    error: state.err,
  };
}
