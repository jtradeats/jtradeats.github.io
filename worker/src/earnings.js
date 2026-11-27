// Finviz earnings calendar (plan: earnings card, 27 Nov 2026): GET /earnings?day=YYYY-MM-DD[&page=N][&fresh=1][&debug=1]
// One US trading day per request, read from finviz.com/calendar/earnings?dateFrom=<day>. Probe results (27 Nov): the page answers the Worker with HTTP 200 in
// 280-500 ms (82-230 KB), is server-rendered HTML, and shows exactly the requested day: <tr class="styled-row ..."> with 14 cells
//   ticker, company, time (BMO = before the open, AMC = after the close), market cap, EPS est/act/sur, EPS GAAP est/act/sur, revenue est/act/sur, 1-day change.
// Rows come sorted by time, then ticker (not by size), so the page filters and ranks by market cap itself. A pager sits under the table: a day that does not
// fit one page has an enabled "Go to next page" link (pages are numbered from 1); this route returns more:true and the page asks for &page=2, 3 ... (a page of
// 40 rows was a single page on 24 Nov). Finviz's terms limit automated access: one page per request, cached (today 10 min, other days 2 h), a failed fetch is not
// repeated for 60 s, and the last good copy is served flagged stale.
// Written with indexOf, not a regex over the whole page: the free plan allows 10 ms CPU per invocation (plan section 3.2).
// Answer: { day, page, updated, via, source, n, more?, rows: [{ s, n, t, c, e, a, u, rv, ra, ch }], stale?, error? }
//   s ticker, n company, t "BMO" | "AMC" | "" (time not given), c market cap in dollars (0 if unreadable), e EPS estimate, a EPS actual, u EPS surprise,
//   rv revenue estimate, ra revenue actual, ch 1-day change: all text exactly as Finviz prints it (null when Finviz shows a dash).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://finviz.com/calendar/earnings';
const TIMEOUT = 6000;
const TTL_TODAY = 10 * 60e3, TTL_OTHER = 2 * 3600e3;   // reuse a built answer this long
const STALE_X = 6;                                      // an answer up to TTL x this is served at once while a refresh runs
const NEG_TTL = 60e3;                                   // after a failed fetch leave Finviz alone for 60 s
const MIN_FRESH = 5e3;                                  // ?fresh=1 is honoured at most this often
const KV_GAP = 10 * 60e3, KV_EXP = 3 * 86400;           // one KV write per key per 10 min, only when something changed; snapshots expire after 3 days
const MAX_PAGE = 6;
const BLOCK_SIGNS = /just a moment|attention required|captcha|access denied|cf-chl|enable javascript and cookies|unusual traffic/i;
const ENT = { '&amp;': '&', '&#39;': "'", '&#x27;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
const text = s => String(s).replace(/<[^>]*>|&(?:amp|#39|#x27|quot|lt|gt|nbsp);/g, m => (m.charCodeAt(0) === 60 ? ' ' : ENT[m])).replace(/\s+/g, ' ').trim();
const dash = s => (!s || s === '—' || s === '-' || s === '–' ? null : s);

// "$241.32M" -> 241320000; "$1.96B"; "$4.65M"; "$215.70B"; "$12.5K"; anything else -> 0
export function capNum(s) {
  const m = /^\$?\s*([\d,]*\.?\d+)\s*([KMBT]?)/i.exec(String(s || ''));
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()] || 1)) : 0;
}

// The page's HTML -> { rows, more, bad, looksLikeEarnings }. A row needs 12 or more cells; anything shorter counts as bad (markup change), never as data.
export function parseEarnings(html) {
  html = String(html || '');
  const rows = [];
  let bad = 0, pos = 0;
  for (;;) {
    const a = html.indexOf('<tr', pos);
    if (a < 0) break;
    const gt = html.indexOf('>', a), b = gt < 0 ? -1 : html.indexOf('</tr>', gt);
    if (b < 0) break;
    pos = b + 5;
    if (html.slice(a, gt).indexOf('styled-row') < 0) continue;
    const cells = [];
    let p = html.indexOf('<td', gt);
    while (p >= 0 && p < b) {
      const open = html.indexOf('>', p), end = html.indexOf('</td>', open);
      if (open < 0 || end < 0 || end > b) break;
      cells.push(html.slice(open + 1, end));
      p = html.indexOf('<td', end);
    }
    if (cells.length < 12) { bad++; continue; }
    const tk = /\/stock\?t=([^"&\s]+)/.exec(cells[0]);
    const s = tk ? decodeURIComponent(tk[1]).toUpperCase() : text(cells[0]).split(' ').pop();
    if (!s) { bad++; continue; }
    const tm = text(cells[2]).toUpperCase();
    const cap = text(cells[3]);
    rows.push({
      s, n: text(cells[1]), t: tm === 'BMO' || tm === 'AMC' ? tm : '', c: capNum(cap),
      e: dash(text(cells[4])), a: dash(text(cells[5])), u: dash(text(cells[6])),
      rv: dash(text(cells[10])), ra: dash(text(cells[11])), ch: dash(text(cells[13] || '')),
    });
  }
  const i = html.indexOf('title="Go to next page"');
  let more = false;
  if (i >= 0) { const st = html.lastIndexOf('<a', i), en = html.indexOf('>', i); more = !/disabled=""/.test(html.slice(st < 0 ? i : st, en < 0 ? i + 200 : en)); }
  const looksLikeEarnings = html.indexOf('<title>Earnings Calendar') >= 0 && html.indexOf('"view":"earnings"') >= 0;
  return { rows, more, bad, looksLikeEarnings, hasLogos: html.indexOf('company-ticker') >= 0 };
}

const ET_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const todayEt = (now = Date.now()) => ET_FMT.format(now);       // "2026-11-27"
const dayMs = iso => Date.parse(iso + 'T12:00:00Z');
export function validDay(day, now = Date.now()) {                       // a real date from 8 days back to 28 days ahead: this is never a proxy for other pages
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false;
  const t = dayMs(day);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return false;
  const d = (t - dayMs(todayEt(now))) / 864e5;
  return d >= -8 && d <= 28;
}

const S = { memo: new Map(), inflight: new Map(), fail: new Map(), lastKv: new Map(), sig: new Map(), seeded: new Set() };
const keyOf = (day, page) => day + '|' + page;
const kvKey = (day, page) => `earnings:${day}:${page}`;
const ttlFor = day => (day === todayEt() ? TTL_TODAY : TTL_OTHER);
const sigOf = v => v.n + '|' + v.rows.map(r => r.s + r.t + (r.a || '') + (r.e || '')).join(',');

async function build(day, page) {
  const url = `${BASE}?dateFrom=${day}${page > 1 ? '&page=' + page : ''}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from finviz.com`);
  const html = await r.text();
  if (BLOCK_SIGNS.test(html.slice(0, 4000)) && html.indexOf('styled-row') < 0) throw new Error('Finviz sent a challenge page');
  const p = parseEarnings(html);
  if (!p.rows.length) {
    // a day with no reports is real (a holiday), but only when the page is plainly the earnings calendar and no row markup is hiding in it
    if (p.bad || p.hasLogos || !p.looksLikeEarnings) throw new Error('parser found no earnings rows (the markup may have changed)');
  } else if (p.bad > p.rows.length) throw new Error(`parser rejected ${p.bad} of ${p.bad + p.rows.length} rows (the markup may have changed)`);
  return { day, page, updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), via: 'worker', source: 'finviz', n: p.rows.length, ...(p.more ? { more: true } : {}), rows: p.rows };
}

async function seed(env, k, day, page) {
  if (S.seeded.has(k)) return;
  S.seeded.add(k);
  if (!(env && env.MARKET_KV)) return;
  try {
    const snap = await env.MARKET_KV.get(kvKey(day, page), 'json');
    if (snap && Array.isArray(snap.rows)) { S.memo.set(k, { at: Date.parse(snap.updated) || 0, val: snap }); S.sig.set(k, sigOf(snap)); }
  } catch (e) { /* KV unavailable: carry on without it */ }
}

function refresh(env, ctx, k, day, page) {
  if (S.inflight.has(k)) return S.inflight.get(k);
  const f = S.fail.get(k), have = S.memo.get(k);
  if (f && Date.now() - f.at < NEG_TTL && have) return Promise.resolve(have);
  const p = build(day, page).then(val => {
    const m = { at: Date.now(), val };
    S.memo.set(k, m); S.fail.delete(k);
    const sig = sigOf(val);
    if (env && env.MARKET_KV && Date.now() - (S.lastKv.get(k) || 0) > KV_GAP && sig !== S.sig.get(k)) {
      S.lastKv.set(k, Date.now()); S.sig.set(k, sig);
      const w = env.MARKET_KV.put(kvKey(day, page), JSON.stringify(val), { expirationTtl: KV_EXP }).catch(() => {});
      if (ctx) ctx.waitUntil(w);
    }
    return m;
  }).catch(e => {
    S.fail.set(k, { at: Date.now(), err: String(e.message).slice(0, 160) });
    if (have) return have;      // keep showing the last good copy, flagged stale below
    throw e;
  }).finally(() => { S.inflight.delete(k); });
  S.inflight.set(k, p);
  return p;
}

function body(k, m, debug) {
  const f = S.fail.get(k), ttl = ttlFor(m.val.day);
  const stale = !!f || Date.now() - m.at > ttl * 2;
  const o = { ...m.val, ...(stale ? { stale: true } : {}), ...(f ? { error: f.err } : {}) };
  if (debug) o.health = { age_s: Math.round((Date.now() - m.at) / 1000), ttl_s: Math.round(ttl / 1000), failAt: f ? f.at : null, err: f ? f.err : null };
  return JSON.stringify(o);
}

// Throws { status: 400 } for a bad day or page; any other throw means Finviz could not be read and there is no copy to show.
export async function getEarnings(env, ctx, opts = {}) {
  const day = opts.day || todayEt(), page = Math.min(MAX_PAGE, Math.max(1, parseInt(opts.page, 10) || 1));
  if (!validDay(day)) { const e = new Error('day must be a date from 8 days back to 28 days ahead (YYYY-MM-DD)'); e.status = 400; throw e; }
  const k = keyOf(day, page);
  if (!S.memo.has(k)) await seed(env, k, day, page);
  const have = S.memo.get(k), age = have ? Date.now() - have.at : Infinity, ttl = ttlFor(day);
  if (opts.fresh && age >= MIN_FRESH) return body(k, await refresh(env, ctx, k, day, page), opts.debug);
  if (age < ttl) return body(k, have, opts.debug);
  if (age < ttl * STALE_X) { const p = refresh(env, ctx, k, day, page); if (ctx) ctx.waitUntil(p.catch(() => {})); return body(k, have, opts.debug); }
  return body(k, await refresh(env, ctx, k, day, page), opts.debug);
}

export const earningsHealth = () => ({ cached: S.memo.size, failing: [...S.fail.entries()].map(([k, v]) => k + ': ' + v.err).slice(0, 5) });
