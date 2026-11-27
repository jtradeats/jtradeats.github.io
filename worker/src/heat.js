// heat.js: GET /heat, the data behind the Heatmap tab's own treemap (plan P8.45, replaces the /heat-test probe).
// Finviz's interactive map is two calls, both read from the Worker with status 200 on 27 Nov (probe, steps layout + data):
//   layout  /api/maps/base/<t>            tree Root > sector > industry > ticker, leaf value = market cap
//   colour  /api/map_perf?t=<t>&st=<st>   { nodes: { TICKER: % change }, ... }
// Valid <t>: sec (S&P 500), sec_ndx (Nasdaq 100), sec_all (all stocks), futures, themes. The names ndx, all, fut, thm are
// IGNORED by Finviz and silently return the S&P 500 (identical bytes in the probe), so they are mapped here, never passed on.
// The Worker never JSON.parses: sec_all's layout is 367 kB and the free plan allows 10 ms CPU. It checks the first bytes,
// caches the text and passes it on; the page merges the two (see heat_merge.js).
const ORIGIN = 'https://finviz.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const MAPS = { sec: 'sec', ndx: 'sec_ndx', all: 'sec_all', futures: 'futures', themes: 'themes' };
const TTL = { base: 6 * 3600e3, perf: 45e3 }, STALE_MAX = 10 * 60e3, BACKOFF = 30e3, TIMEOUT = 5000;
const HEAD = { base: '{"name":"Root"', perf: '{"nodes":{' };   // what a real reply starts with; a block page or an error does not
const memo = new Map();   // key -> { at, body, failAt }
export function _reset() { memo.clear(); }

async function pull(part, t, st, fresh, now) {
  const key = part + '|' + t + '|' + (part === 'perf' ? st : '');
  const m = memo.get(key) || {};
  if (m.body && now - m.at < TTL[part] && !(fresh && now - m.at > 5000)) return { body: m.body, src: 'memo', at: m.at };
  if (m.failAt && now - m.failAt < BACKOFF && m.body && now - m.at < STALE_MAX) return { body: m.body, src: 'stale', at: m.at };
  try {
    const url = part === 'base' ? `${ORIGIN}/api/maps/base/${t}` : `${ORIGIN}/api/map_perf?t=${t}&st=${st}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: ORIGIN + '/map?t=' + t }, signal: AbortSignal.timeout(TIMEOUT) });
    const body = await r.text();
    if (!r.ok || !body.startsWith(HEAD[part])) throw new Error(`${part} ${t}: status ${r.status}, unexpected start`);
    memo.set(key, { at: now, body });
    return { body, src: 'fresh', at: now };
  } catch (e) {
    memo.set(key, { ...m, failAt: now });
    // the base layout changes at most daily, so an old copy is safe for much longer than a perf copy
    const limit = part === 'base' ? 24 * 3600e3 : STALE_MAX;
    if (m.body && now - m.at < limit) return { body: m.body, src: 'stale', at: m.at };
    throw e;
  }
}

// ?t=sec|ndx|all|futures|themes (default sec)  ?st=d1 (default; only d1 is verified)  ?part=perf|base (default perf)  ?fresh=1
export async function heatRoute(req, headers, now = Date.now()) {
  const q = new URL(req.url).searchParams;
  const key = q.get('t') || 'sec', t = MAPS[key];
  const part = q.get('part') || 'perf', st = q.get('st') || 'd1';
  const bad = m => new Response(JSON.stringify({ error: m, maps: Object.keys(MAPS) }), { status: 400, headers });
  if (!t) return bad('unknown map ' + key);
  if (part !== 'perf' && part !== 'base') return bad('part must be perf or base');
  if (!/^[a-z0-9_]{2,12}$/.test(st)) return bad('bad st');
  const f = q.get('fresh'), fresh = f !== null && f !== '0' && f !== 'false';
  const r = await pull(part, t, st, fresh, now);
  return new Response(r.body, { headers: { ...headers, 'Cache-Control': 'public, max-age=' + (part === 'base' ? 600 : 20), 'X-Heat-Source': r.src, 'X-Heat-Age': String(Math.round((now - r.at) / 1000)) } });
}
