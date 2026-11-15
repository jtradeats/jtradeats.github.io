// Shared plumbing for the small on-demand market routes (/sectors, /weekly).
// Same behaviour as /market in index.js: a per-item cache, a negative cache after a failure, a 5 s deadline,
// a short response memo that is served at once while a refresh runs, and a throttled KV snapshot for cold starts.
// index.js is not touched by this file; later cleanup (plan P8.8) can fold its own get() and qYahoo() into this one.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SRC_TIMEOUT = 4000;   // per upstream request

export async function get(url, headers = {}, timeout = SRC_TIMEOUT) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.text();
}

// One Yahoo chart call, second host as the retry (so 1 subrequest normally, 2 when the first host fails).
export async function chart(sym, range, interval) {
  let err;
  for (const host of ['query1', 'query2']) {
    try {
      const j = JSON.parse(await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`));
      const r = j.chart.result[0];
      if (!r || !r.meta) throw new Error('empty chart result');
      return r;
    } catch (e) { err = e; }
  }
  throw err;
}

export function quote(price, prev, t) {
  price = Number(price);
  const out = { p: +price.toFixed(4), t: t ?? null };
  if (prev != null && Number(prev) !== 0) {
    prev = Number(prev);
    out.c = +(price - prev).toFixed(4);
    out.pc = +(((price - prev) / prev) * 100).toFixed(3);
  }
  return out;
}

// cfg: { name, kvKey, specs, fetchOne(spec, env) -> item, finish?(items, env, now, notes) -> { items?, extra? },
//        ttl, negTtl, deadline, staleOk, kvGap }
// fetchOne must throw on a bad answer; it never has to catch. The returned item needs at least { p, t }.
export function makeRoute(cfg) {
  const { name, kvKey, specs, fetchOne, finish,
    ttl = 30000,                 // reuse a fetched item for 30 s (Yahoo is delayed 10 min or more anyway)
    negTtl = 60000,              // after a failure leave that item alone for 60 s
    deadline = 5000,             // never make the page wait longer than this for a build
    staleOk = 5 * 60000,         // a memo up to this old is served at once while a refresh runs
    minFresh = 5000,             // ?fresh=1 (manual refresh) is honoured at most this often
    kvGap = 30 * 60000,          // KV allows 1,000 writes/day: at most one snapshot per 30 min, and only when a newer quote exists
  } = cfg;

  const cache = new Map();       // label -> { val, at, failAt }
  let memo = null, inflight = null, seeded = false, lastKv = 0, lastSig = '';
  const sigOf = items => String(Math.max(0, ...items.map(i => i.t || 0)));

  async function load(spec, env, log) {
    const c = cache.get(spec.label) || {};
    const now = Date.now();
    if (c.val && now - c.at < ttl) return;
    if (c.failAt && now - c.failAt < negTtl) return;
    try {
      const val = await fetchOne(spec, env);
      if (!Number.isFinite(val.p) || val.p <= 0) throw new Error('bad price');
      cache.set(spec.label, { val: { label: spec.label, name: spec.name, kind: spec.kind, ...val }, at: Date.now() });
    } catch (e) {
      log.push(`${spec.label} failed: ${e.message}`.slice(0, 200));
      cache.set(spec.label, { ...c, failAt: Date.now() });
    }
  }

  async function build(env, ctx) {
    const log = [], notes = [];
    const work = Promise.all(specs.map(s => load(s, env, log)));
    const done = await Promise.race([work.then(() => true), new Promise(r => setTimeout(() => r(false), deadline))]);
    if (ctx) ctx.waitUntil(work);   // late sources keep running and land in the cache for the next request
    if (!done) notes.push(`deadline hit (${deadline} ms): slow sources will show in the next response`);

    const now = Date.now();
    let items = specs.map(s => {
      const c = cache.get(s.label);
      if (c && c.val) {
        const stale = (c.failAt && c.failAt > c.at) || now - c.at > ttl + 60000;
        return stale ? { ...c.val, stale: true } : c.val;
      }
      return { label: s.label, name: s.name, kind: s.kind, p: null };
    });
    let extra = {};
    if (finish) {
      const f = await finish(items, env, now, notes);
      if (f && f.items) items = f.items;
      if (f && f.extra) extra = f.extra;
    }
    return {
      updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),   // when this response was built, not when the quotes were made
      ...extra, items, errors: log.slice(0, 20), notes: notes.slice(0, 10), via: 'worker',
    };
  }

  async function seed(env) {
    seeded = true;
    if (!(env && env.MARKET_KV)) return;
    try {
      const snap = await env.MARKET_KV.get(kvKey, 'json');
      if (!snap || !Array.isArray(snap.items)) return;
      for (const it of snap.items) {
        if (it.p == null || cache.has(it.label)) continue;
        const { stale, ...val } = it;
        cache.set(it.label, { val, at: val.f || 0 });   // last good value; refetched at once (its age is already past the ttl)
      }
      lastSig = sigOf(snap.items);                       // so a cold isolate does not rewrite an identical snapshot (weekends)
      const at = Date.parse(snap.updated);
      if (!memo && at) memo = { at, body: JSON.stringify(snap) };
    } catch (e) { /* KV unavailable: carry on without it */ }
  }

  function refresh(env, ctx) {
    if (!inflight) {
      inflight = build(env, ctx).then(async b => {
        const body = JSON.stringify(b);
        memo = { at: Date.now(), body };
        const sig = sigOf(b.items);
        if (env && env.MARKET_KV && Date.now() - lastKv > kvGap && sig !== lastSig && b.items.some(i => i.p != null)) {
          lastKv = Date.now(); lastSig = sig;
          try { await env.MARKET_KV.put(kvKey, body); } catch (e) { /* ignore: a failed write never reaches the page */ }
        }
        return body;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function getBody(env, ctx, opts = {}) {
    if (!seeded) await seed(env);
    const age = memo ? Date.now() - memo.at : Infinity;
    if (opts.fresh && age >= minFresh) {                 // manual refresh: wait for a new build (still capped by the deadline)
      try { return await refresh(env, ctx); } catch (e) { if (memo) return memo.body; throw e; }
    }
    if (age < ttl) return memo.body;
    if (age < staleOk) {
      const p = refresh(env, ctx);
      if (ctx) ctx.waitUntil(p.catch(() => {}));
      return memo.body;
    }
    try { return await refresh(env, ctx); }
    catch (e) { if (memo) return memo.body; throw e; }
  }

  return {
    name,
    get: getBody,
    seed: env => (seeded ? Promise.resolve() : seed(env)),
    health: () => ({ age_s: memo ? Math.round((Date.now() - memo.at) / 1000) : null, cached_items: cache.size, items: specs.length }),
  };
}
