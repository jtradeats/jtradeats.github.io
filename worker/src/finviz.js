// Finviz news: GET /finviz (the card's data) and GET /finviz-test (the diagnostic probe).
// GET /finviz              -> { updated, items: [{ t, d, title, url, src, host }], blogs: [...] } parsed from finviz.com/news; ?fresh=1 = manual refresh; ?debug=1 adds table/row counts
// The probe below stays for diagnosis:
// GET /finviz-test            -> what finviz.com/news.ashx returns to this Worker: status, blocking signs, and the first headline links found
// GET /finviz-test?v=2        -> the same for news.ashx?v=2 (digits 1 to 3 only; the address is fixed, this is never a proxy for other pages)
// GET /finviz-test?raw=1      -> adds ~1,500 characters of raw markup around the first headline found, so the real parser can be written from it
// It makes ONE request to Finviz per call and reuses the last answer for 60 s, so refreshing the page cannot hammer their server.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://finviz.com/news.ashx';
const TIMEOUT = 5000;
const REUSE = 60000;

const memo = new Map();   // key -> { at, body }

const BLOCK_SIGNS = /just a moment|attention required|captcha|access denied|cf-chl|enable javascript and cookies|unusual traffic|rate limit/i;
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export async function finvizProbe(reqUrl) {
  const q = new URL(reqUrl).searchParams;
  const v = /^[1-3]$/.test(q.get('v') || '') ? q.get('v') : '';
  const raw = q.has('raw');
  const key = `${v}|${raw}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < REUSE) return hit.body;

  const url = v ? `${BASE}?v=${v}` : BASE;
  const out = { url, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const html = await r.text();
    out.ms = Date.now() - t0;
    out.status = r.status;
    out.ok = r.ok;
    out.finalUrl = r.url;
    out.redirected = r.redirected;
    out.contentType = r.headers.get('content-type');
    out.server = r.headers.get('server');
    out.cfMitigated = r.headers.get('cf-mitigated');      // "challenge" means Cloudflare on Finviz's side is challenging us
    out.cacheControl = r.headers.get('cache-control');
    out.bytes = html.length;
    out.title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ? decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)[1]).slice(0, 160) : null;
    out.blockedSigns = (html.match(BLOCK_SIGNS) || [null])[0];
    out.scripts = (html.match(/<script\b/gi) || []).length;
    out.hasNextData = /__NEXT_DATA__/.test(html);          // headlines inside JSON instead of HTML would show here
    out.mentionsNews = /news[_-]?table|news[_-]?row|nn-tab-link|news_link/i.test(html);

    // generic extraction: external links with a headline-length text (works whatever the class names are)
    const items = [], seen = new Set();
    const re = /<a\b[^>]*?href="(https?:\/\/[^"]+)"[^>]*>([^<]{25,300})<\/a>/gi;
    let m, first = -1;
    while ((m = re.exec(html)) && items.length < 25) {
      let host = '';
      try { host = new URL(m[1]).host.replace(/^www\./, ''); } catch (e) { continue; }
      if (/(^|\.)finviz\.com$/.test(host)) continue;
      const title = decode(m[2]);
      if (seen.has(title)) continue;
      seen.add(title);
      if (first < 0) first = m.index;
      items.push({ title, host, href: m[1].slice(0, 200) });
    }
    out.found = items.length;
    out.items = items.slice(0, 15);
    if (raw) out.rawAroundFirst = first >= 0 ? html.slice(Math.max(0, first - 700), first + 800) : html.slice(0, 1500);
    else if (!items.length) out.head = html.slice(0, 400);

    out.verdict = !r.ok ? `blocked or failed: HTTP ${r.status}`
      : out.blockedSigns || out.cfMitigated ? 'challenge page: Finviz is blocking this Worker'
      : items.length >= 5 ? 'readable: headlines found in the HTML, a real parser is possible'
      : out.hasNextData ? 'page loads, but headlines look to be inside JSON (__NEXT_DATA__): parse that instead'
      : 'page loads but no headlines found in the HTML: probably drawn by JavaScript; send ?raw=1 output';
  } catch (e) {
    out.ms = Date.now() - t0;
    out.error = String(e && e.message).slice(0, 200);
    out.verdict = 'request failed (timeout or network)';
  }
  const body = JSON.stringify(out, null, 1);
  memo.set(key, { at: Date.now(), body });
  return body;
}


// ======================= the real route: GET /finviz =======================
// Parses the public page's server-rendered rows:  <tr class="... news_table-row"> <td news_first-time-cell>(source icon)</td>
//   <td news_date-cell>10:21PM</td> <td news_link-cell><a class="nn-tab-link" href="...">headline</a></td></tr>
// Behaviour matches the other routes: a short reuse time, a negative cache after a failure, the last good copy served (flagged stale) when Finviz fails,
// and a throttled KV snapshot for cold starts. A page that parses to fewer than MIN_ROWS rows counts as a failure, so a markup change shows "delayed"
// on the card instead of wiping it.

const KV_KEY = 'finviz:news';
const TTL = 45000;            // reuse a built answer for 45 s (the card polls about every 60 s)
const STALE_OK = 10 * 60000;  // an answer up to this old is served at once while a refresh runs
const NEG_TTL = 60000;        // after a failed fetch leave Finviz alone for 60 s
const MIN_FRESH = 5000;       // ?fresh=1 is honoured at most this often
const KV_GAP = 15 * 60000;    // KV allows 1,000 writes/day: one snapshot per 15 min, only when the top headline changed
const MIN_ROWS = 5, MAX_ITEMS = 60;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function etFields(ms) { const o = {}; for (const p of ET.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = +p.value; return o; }
const offsetAt = ms => { const f = etFields(ms); return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - Math.floor(ms / 60000) * 60000; };   // ET minus UTC at that moment (negative)
function etWallToMs(y, mo, d, h, mi) { const g = Date.UTC(y, mo - 1, d, h, mi); return g - offsetAt(g - offsetAt(g)); }              // New York wall-clock time -> epoch ms (DST-safe)
const addDays = (day, n) => { const u = new Date(Date.UTC(day.y, day.mo - 1, day.d + n)); return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate() }; };

const SRC = { 'reuters.com': 'Reuters', 'bloomberg.com': 'Bloomberg', 'wsj.com': 'WSJ', 'cnbc.com': 'CNBC', 'nytimes.com': 'NYT', 'foxbusiness.com': 'Fox Business', 'marketwatch.com': 'MarketWatch',
  'bbc.co.uk': 'BBC', 'bbc.com': 'BBC', 'ft.com': 'FT', 'barrons.com': "Barron's", 'finance.yahoo.com': 'Yahoo Finance', 'yahoo.com': 'Yahoo', 'investing.com': 'Investing.com',
  'seekingalpha.com': 'Seeking Alpha', 'benzinga.com': 'Benzinga', 'apnews.com': 'AP', 'forbes.com': 'Forbes', 'businessinsider.com': 'Business Insider', 'theguardian.com': 'Guardian',
  'axios.com': 'Axios', 'politico.com': 'Politico', 'washingtonpost.com': 'Washington Post', 'thestreet.com': 'TheStreet', 'fool.com': 'Motley Fool', 'cnn.com': 'CNN' };
function srcName(host) {
  host = String(host || '').replace(/^www\./, '');
  if (SRC[host]) return SRC[host];
  const parts = host.split('.'); if (parts.length < 2) return host;
  const sld = /^(co|com|org|net|gov)$/.test(parts[parts.length - 2]) && parts.length > 2 ? parts[parts.length - 3] : parts[parts.length - 2];
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

const DATE_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-(\d{1,2})(?:-(\d{2,4}))?$/i;
const TIME_RE = /^(?:(?:today\s+)|(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-(\d{1,2})(?:-(\d{2,4}))?\s+))?(\d{1,2}):(\d{2})\s*(am|pm)$/i;

// html -> [ { rows: [...] } per <table> that holds news rows ], rows newest first, times as epoch ms
export function parseFinviz(html, now = Date.now()) {
  const tables = [];
  for (const chunk of html.split(/<table\b/i).slice(1)) {
    const rows = [];
    const re = /<tr\b[^>]*news_table-row[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = re.exec(chunk))) {
      const row = m[1];
      const a = row.match(/<a\b[^>]*nn-tab-link[^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;
      const href = (a[0].match(/href="([^"]+)"/i) || [])[1];
      if (!href || !/^https?:\/\//i.test(href)) continue;
      const title = decode(a[1].replace(/<[^>]*>/g, ''));
      const cell = (row.match(/news_date-cell[^>]*>([\s\S]*?)<\/td>/i) || [])[1];
      const when = cell ? decode(cell.replace(/<[^>]*>/g, '')) : '';
      if (!title) continue;
      let host = ''; try { host = new URL(decode(href)).host.replace(/^www\./, ''); } catch (e) { continue; }
      rows.push({ title, url: decode(href), host, when });
    }
    if (rows.length) tables.push(rows);
  }
  const nowEt = etFields(now);
  const out = tables.map(rows => {
    let day = { y: nowEt.year, mo: nowEt.month, d: nowEt.day }, prev = null;
    const seen = new Set(), items = [];
    for (const r of rows) {
      const m = r.when.match(TIME_RE);
      let t = null, d = 'i', dayIso = null;
      if (m) {
        let h = +m[4] % 12; if (/pm/i.test(m[6])) h += 12;
        const mi = +m[5];
        if (m[1]) {                                           // an explicit date on the row: trust it
          let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : nowEt.year;
          day = { y, mo: MONTHS[m[1].toLowerCase()], d: +m[2] };
          t = etWallToMs(day.y, day.mo, day.d, h, mi);
          if (!m[3] && t > now + 36e5 * 36) { day = { ...day, y: y - 1 }; t = etWallToMs(day.y, day.mo, day.d, h, mi); }
          d = 'x';
        } else {                                              // time only: newest first, so the day steps back whenever the clock jumps forward
          t = etWallToMs(day.y, day.mo, day.d, h, mi);
          for (let i = 0; i < 3 && t > (prev == null ? now + 10 * 60000 : prev + 5 * 60000); i++) { day = addDays(day, -1); t = etWallToMs(day.y, day.mo, day.d, h, mi); }
        }
        prev = t;
      } else {                                                // date only (Finviz drops the time on older rows): keep the day, no time
        const dm = r.when.match(DATE_RE);
        if (dm) {
          const mo = MONTHS[dm[1].toLowerCase()];
          let y = dm[3] ? (+dm[3] < 100 ? 2000 + +dm[3] : +dm[3]) : nowEt.year;
          if (!dm[3] && etWallToMs(y, mo, +dm[2], 12, 0) > now + 36e5 * 36) y--;
          day = { y, mo, d: +dm[2] }; d = 'x';
          dayIso = y + '-' + String(mo).padStart(2, '0') + '-' + String(+dm[2]).padStart(2, '0');
        }
      }
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      items.push({ t, d, ...(dayIso ? { day: dayIso } : {}), title: r.title, url: r.url, src: srcName(r.host), host: r.host });
    }
    return items.slice(0, MAX_ITEMS);
  });
  return out;
}

const S = { memo: null, inflight: null, failAt: 0, err: null, seeded: false, lastKv: 0, lastSig: '' };

async function build(env) {
  const r = await fetch(BASE, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from finviz.com`);
  const html = await r.text();
  if (BLOCK_SIGNS.test(html.slice(0, 4000)) && !/news_table-row/.test(html)) throw new Error('Finviz sent a challenge page');
  const tables = parseFinviz(html, Date.now());
  const news = tables[0] || [];
  if (news.length < MIN_ROWS) throw new Error(`parser found ${news.length} headline rows (the markup may have changed)`);
  return { updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), via: 'worker', source: 'finviz', n: news.length, items: news, blogs: tables[1] || [], tables: tables.map(t => t.length) };
}

async function seed(env) {
  S.seeded = true;
  if (!(env && env.MARKET_KV)) return;
  try {
    const snap = await env.MARKET_KV.get(KV_KEY, 'json');
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      S.memo = { at: Date.parse(snap.updated) || 0, val: snap };
      S.lastSig = sigOf(snap);
    }
  } catch (e) { /* KV unavailable: carry on without it */ }
}
const sigOf = v => (v.items[0] ? v.items[0].title : '') + '|' + v.items.length;

function refresh(env, ctx) {
  if (S.inflight) return S.inflight;
  if (S.failAt && Date.now() - S.failAt < NEG_TTL && S.memo) return Promise.resolve(S.memo);   // just failed: do not ask again yet
  S.inflight = build(env).then(val => {
    S.memo = { at: Date.now(), val }; S.err = null; S.failAt = 0;
    const sig = sigOf(val);
    if (env && env.MARKET_KV && Date.now() - S.lastKv > KV_GAP && sig !== S.lastSig) {
      S.lastKv = Date.now(); S.lastSig = sig;
      const w = env.MARKET_KV.put(KV_KEY, JSON.stringify(val)).catch(() => {});   // a failed write never reaches the page
      if (ctx) ctx.waitUntil(w);
    }
    return S.memo;
  }).catch(e => {
    S.failAt = Date.now(); S.err = String(e.message).slice(0, 160);
    if (S.memo) return S.memo;      // keep showing the last good copy, flagged stale below
    throw e;
  }).finally(() => { S.inflight = null; });
  return S.inflight;
}

function body(m, debug) {
  const stale = !!S.err || Date.now() - m.at > TTL + 60000 * 5;
  const o = { ...m.val, ...(stale ? { stale: true } : {}), ...(S.err ? { error: S.err } : {}) };
  if (!debug) delete o.tables; else o.health = { age_s: Math.round((Date.now() - m.at) / 1000), failAt: S.failAt || null, err: S.err };
  return JSON.stringify(o);
}

export async function getFinviz(env, ctx, opts = {}) {
  if (!S.seeded) await seed(env);
  const age = S.memo ? Date.now() - S.memo.at : Infinity;
  if (opts.fresh && age >= MIN_FRESH) return body(await refresh(env, ctx), opts.debug);
  if (age < TTL) return body(S.memo, opts.debug);
  if (age < STALE_OK) { const p = refresh(env, ctx); if (ctx) ctx.waitUntil(p.catch(() => {})); return body(S.memo, opts.debug); }
  return body(await refresh(env, ctx), opts.debug);
}

export const finvizHealth = () => ({ age_s: S.memo ? Math.round((Date.now() - S.memo.at) / 1000) : null, n: S.memo ? S.memo.val.items.length : 0, err: S.err });
