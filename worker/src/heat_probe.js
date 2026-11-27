// heat_probe.js: TEST ONLY, read only. Remove the route and this file once the real heatmap route replaces them (plan P8.45).
// Purpose: find out, from the Worker's own network address, WHERE Finviz's interactive map gets its tile layout
// (sector, industry, market cap) and whether the Worker can read it for the five maps J uses (All, S&P 500, Nasdaq 100,
// Futures, Themes). Known so far: /api/map_perf.ashx gives only ticker -> % change. The layout must come from somewhere else.
// The page and its scripts are read once, nothing is stored, nothing is sent anywhere but to finviz.com, tradingview.com and nasdaq.com.
//
// Routes (all GET, JSON out, one run per 20 s, the same URL again within 60 s returns the last answer):
//   /heat-test                      step "page": the map page, its scripts, and a scan of up to 3 same-site scripts for data requests and map names
//   /heat-test?s=3,4                the same, but scan scripts number 3 and 4 of the list (the list is in the answer)
//   /heat-test?step=data            map_perf for t = sec, sec_ndx, sec_all, ndx, all, fut, futures, thm, themes (add ?t=a,b to choose; ?st=w1 for another period)
//   /heat-test?step=uni             fallbacks: TradingView scanner (all US, S&P 500, Nasdaq 100) and Nasdaq's public screener, 5 rows each
//   /heat-test?step=get&path=/api/xyz.ashx?t=sec    one GET of a finviz.com path under /api/ (or an .ashx page) found by the page step
//   /heat-test?step=layout          the map's layout call: code around /api/maps/base, /api/map_sparklines and /api/maps/counts in chunk 6178, and /api/maps/base/<t> for the five maps
//   /heat-test?step=scan            reads every same-site script of the map page, plus the lazy chunks named in the webpack runtime, looking only for data requests (?from=24&n=24 for the next batch)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ORIGIN = 'https://finviz.com';
const GAP = 20000, MEMO = 60000, TIMEOUT = 6000;
const state = { at: 0, key: null, body: null };

const STOP = new Set([34, 39, 96, 32, 41, 10, 13, 44, 59, 92, 60, 62, 123, 125]);   // " ' ` space ) newline , ; \ < > { }

// A window of text around the first place a phrase appears, or null.
export function around(text, phrase, before, after) {
  const i = text.indexOf(phrase);
  return i < 0 ? null : text.slice(Math.max(0, i - before), Math.min(text.length, i + after));
}

// Distinct tokens that start with a needle and run to the next quote, space or bracket (for "/api/..." paths).
export function tokensAfter(text, needle, cap = 60, max = 90) {
  const seen = new Set();
  let i = 0, guard = 0;
  while (seen.size < cap && guard++ < 20000 && (i = text.indexOf(needle, i)) >= 0) {
    let j = i + needle.length;
    const lim = Math.min(text.length, i + max);
    while (j < lim && !STOP.has(text.charCodeAt(j))) j++;
    seen.add(text.slice(i, j));
    i += needle.length;
  }
  return [...seen];
}

// How many times a needle appears (capped); for a map_perf-style object, '":' counts the entries plus a few keys.
export function countNeedle(text, needle, cap = 200000) {
  let n = 0, i = 0;
  while (n < cap && (i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

// The page's <script> tags and the .js files it preloads.
export function listAssets(html) {
  const scripts = [];
  let i = 0, guard = 0;
  while (guard++ < 300 && (i = html.indexOf('<script', i)) >= 0) {
    const e = html.indexOf('>', i);
    if (e < 0) break;
    const tag = html.slice(i, e + 1), close = html.indexOf('</script>', e);
    const src = /\ssrc=["']([^"']+)["']/i.exec(tag), type = /\stype=["']([^"']+)["']/i.exec(tag), id = /\sid=["']([^"']+)["']/i.exec(tag);
    scripts.push({ src: src ? src[1] : null, type: type ? type[1] : null, id: id ? id[1] : null, inlineBytes: src || close < 0 ? 0 : close - e - 1, bodyAt: e + 1 });
    i = e + 1;
  }
  const preloads = [];
  i = 0; guard = 0;
  while (guard++ < 300 && (i = html.indexOf('<link', i)) >= 0) {
    const e = html.indexOf('>', i);
    if (e < 0) break;
    const m = /\shref=["']([^"']+\.js[^"']*)["']/i.exec(html.slice(i, e + 1));
    if (m) preloads.push(m[1]);
    i = e + 1;
  }
  return { scripts, preloads };
}

export function sameSite(href) {
  try { const h = new URL(href, ORIGIN + '/map.ashx').hostname; return h === 'finviz.com' || h.endsWith('.finviz.com'); } catch { return false; }
}
const absUrl = (href) => new URL(href, ORIGIN + '/map.ashx').href;

// What to look for inside one script: the data requests it makes and the table of map names.
export function scanBundle(text) {
  const out = { bytes: text.length, api: tokensAfter(text, '/api/', 60), ashx: tokensAfter(text, 'ashx?', 20, 60) };
  const wins = [];
  let i = 0, guard = 0;
  while (wins.length < 4 && guard++ < 50 && (i = text.indexOf('map_perf', i)) >= 0) { wins.push(text.slice(Math.max(0, i - 160), i + 240)); i += 8; }
  out.mapPerf = wins;
  const seen = new Set(), names = {};
  for (const [k, ph, b, a] of [['sec_ndx', 'sec_ndx', 500, 900], ['sec_all', 'sec_all', 300, 600], ['themes', 'themes', 250, 500], ['Themes', 'Themes', 250, 500], ['futures', 'futures', 250, 500], ['Futures', 'Futures', 250, 500], ['marketCap', 'marketCap', 200, 400], ['market_cap', 'market_cap', 200, 400]]) {
    const w = around(text, ph, b, a);
    if (w && !seen.has(w)) { seen.add(w); names[k] = w; }
  }
  out.names = names;
  return out;
}


// Up to `count` windows of text around a needle.
export function windows(text, needle, count = 3, pad = 70) {
  const out = [];
  let i = 0, guard = 0;
  while (out.length < count && guard++ < 200 && (i = text.indexOf(needle, i)) >= 0) { out.push(text.slice(Math.max(0, i - pad), i + needle.length + pad)); i += needle.length; }
  return out;
}

// Chunk files named in a webpack runtime ("1502:\"d0983e46\"" pairs) as /assets/dist/<id>.v1.<hash>.js
export function chunkUrls(runtimeText) {
  const out = [], seen = new Set(), re = /["']?([A-Za-z0-9_]{1,40})["']?\s*:\s*["']([0-9a-f]{8})["']/g;
  let m, guard = 0;
  while ((m = re.exec(runtimeText)) && guard++ < 3000) {
    const u = ORIGIN + '/assets/dist/' + m[1] + '.v1.' + m[2] + '.js';
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}
const SKIP_SCAN = /browser_check|notice|header|google_one_tap|\/pv\.|knowledge_base|elite_features|libs_init|finviz_t\.|\/runtime\./;

export function summarise(text, headLen = 220, count = true) {
  return { bytes: text.length, approxEntries: count && text.length < 300000 ? countNeedle(text, '":') : null, head: text.slice(0, headLen), tail: text.length > 500 ? text.slice(-200) : null };
}

async function get(url, extra = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Referer: ORIGIN + '/map.ashx', ...extra }, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await r.text();
  return { r, text, ms: Date.now() - t0 };
}
const botCheck = (text) => /Just a moment|cf-chl|Attention Required|captcha/i.test(text.slice(0, 4000));
const errOf = (e) => String(e && e.message).slice(0, 200);

async function stepPage(q) {
  const out = { step: 'page', ok: false, url: ORIGIN + '/map.ashx?t=sec' };
  const { r, text: html, ms } = await get(out.url);
  out.status = r.status; out.ms = ms; out.bytes = html.length; out.finalUrl = r.url; out.blocked = botCheck(html); out.ok = r.ok && !out.blocked;
  if (!out.ok) { out.head = html.slice(0, 400); return out; }
  const { scripts, preloads } = listAssets(html);
  const eligible = [];
  scripts.forEach((s, n) => { if (s.src && sameSite(s.src)) eligible.push({ n, src: absUrl(s.src) }); });
  out.title = (/<title>([^<]{0,120})/i.exec(html) || [])[1] || null;
  out.scriptCount = scripts.length;
  out.sameSiteScripts = eligible.map((e, k) => ({ s: k, src: e.src }));
  out.otherScripts = scripts.filter(s => s.src && !sameSite(s.src)).map(s => s.src).slice(0, 12);
  out.preloadedJs = preloads.slice(0, 20);
  out.inline = scripts.filter(s => !s.src && s.inlineBytes > 0).slice(0, 12).map(s => ({ type: s.type, id: s.id, bytes: s.inlineBytes, head: html.slice(s.bodyAt, s.bodyAt + 300) }));
  out.htmlApi = tokensAfter(html, '/api/', 30);
  out.htmlMapPerf = around(html, 'map_perf', 200, 400);
  // which scripts to read: ?s=3,4, else up to three whose name mentions "map", then the first ones
  let pick = (q.get('s') || '').split(',').map(x => parseInt(x, 10)).filter(x => x >= 0 && x < eligible.length);
  if (!pick.length) {
    const byMap = eligible.map((e, k) => (/map/i.test(e.src) ? k : -1)).filter(k => k >= 0);
    pick = [...byMap, ...eligible.map((_, k) => k).filter(k => !byMap.includes(k))];
  }
  pick = pick.slice(0, 3);
  const scans = await Promise.all(pick.map(async k => {
    try {
      const g = await get(eligible[k].src);
      const o = { s: k, src: eligible[k].src, status: g.r.status, ms: g.ms };
      return g.r.ok ? { ...o, ...scanBundle(g.text) } : o;
    } catch (e) { return { s: k, src: eligible[k].src, error: errOf(e) }; }
  }));
  out.scanned = scans;
  out.next = 'If no data request for the layout shows in api/ashx/mapPerf: run /heat-test?s=<other numbers from sameSiteScripts>';
  return out;
}

async function stepData(q) {
  const ts = (q.get('t') || 'sec,sec_ndx,sec_all,ndx,all,fut,futures,thm,themes').split(',').map(x => x.trim()).filter(x => /^[a-z0-9_]{1,20}$/i.test(x)).slice(0, 12);
  const st = /^[a-z0-9]{1,8}$/i.test(q.get('st') || '') ? q.get('st') : 'd1';
  const res = await Promise.all(ts.map(async t => {
    const url = `${ORIGIN}/api/map_perf.ashx?t=${t}&st=${st}`;
    try {
      const g = await get(url);
      const o = { t, status: g.r.status, ms: g.ms, contentType: g.r.headers.get('content-type'), blocked: botCheck(g.text) };
      return g.r.ok ? { ...o, ...summarise(g.text) } : { ...o, head: g.text.slice(0, 160) };
    } catch (e) { return { t, error: errOf(e) }; }
  }));
  return { step: 'data', st, results: res, note: 'approxEntries is the count of "key": pairs (entries plus a few wrapper keys); an entry with an object instead of a number means size or sector data is inside' };
}

const TV = 'https://scanner.tradingview.com/america/scan';
const TV_COLS = ['name', 'description', 'market_cap_basic', 'sector', 'industry', 'change', 'close', 'exchange'];
function tvBody(extra) {
  return JSON.stringify({ markets: ['america'], options: { lang: 'en' }, columns: TV_COLS, sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, range: [0, 5], ...extra });
}
async function tv(label, extra) {
  try {
    const t0 = Date.now();
    const r = await fetch(TV, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' }, body: tvBody(extra), signal: AbortSignal.timeout(TIMEOUT) });
    const text = await r.text();
    const o = { label, status: r.status, ms: Date.now() - t0, bytes: text.length };
    if (!r.ok) return { ...o, head: text.slice(0, 200) };
    let j = null; try { j = JSON.parse(text); } catch { /* shown below */ }
    return j ? { ...o, totalCount: j.totalCount, rows: (j.data || []).slice(0, 3) } : { ...o, head: text.slice(0, 200) };
  } catch (e) { return { label, error: errOf(e) }; }
}
async function nasdaq() {
  const url = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=5&offset=0&download=true';
  try {
    const t0 = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' }, signal: AbortSignal.timeout(TIMEOUT) });
    const text = await r.text();
    return { label: 'nasdaq screener', status: r.status, ms: Date.now() - t0, bytes: text.length, head: text.slice(0, 600) };
  } catch (e) { return { label: 'nasdaq screener', error: errOf(e) }; }
}
async function stepUni() {
  const stock = { filter: [{ left: 'type', operation: 'equal', right: 'stock' }, { left: 'typespecs', operation: 'has', right: ['common'] }] };
  const results = await Promise.all([
    tv('tradingview all US common stocks', { symbols: { query: { types: [] }, tickers: [] }, ...stock }),
    tv('tradingview S&P 500 (symbolset SYML:SP;SPX)', { symbols: { symbolset: ['SYML:SP;SPX'] } }),
    tv('tradingview Nasdaq 100 (symbolset SYML:NASDAQ;NDX)', { symbols: { symbolset: ['SYML:NASDAQ;NDX'] } }),
    nasdaq(),
  ]);
  return { step: 'uni', results, note: 'Looking for: status 200; totalCount near 500 and 100 for the two index sets; sector and industry names (compare with Finviz: Technology, Consumer Electronics)' };
}


async function stepScan(q) {
  const from = Math.max(0, parseInt(q.get('from') || '0', 10) || 0), n = Math.min(40, Math.max(1, parseInt(q.get('n') || '24', 10) || 24));
  const page = await get(ORIGIN + '/map.ashx?t=sec');
  const out = { step: 'scan', ok: false, status: page.r.status };
  if (!page.r.ok || botCheck(page.text)) { out.head = page.text.slice(0, 300); return out; }
  const { scripts, preloads } = listAssets(page.text);
  const urls = [], seen = new Set();
  const add = (href) => { if (!sameSite(href) || SKIP_SCAN.test(href)) return; const u = absUrl(href); if (!seen.has(u.split('?')[0])) { seen.add(u.split('?')[0]); urls.push(u); } };
  scripts.forEach(x => { if (x.src) add(x.src); });
  preloads.forEach(add);
  const rtUrl = scripts.map(x => x.src).filter(Boolean).map(absUrl).find(u => /\/runtime\./.test(u));
  out.pageScripts = urls.length;
  if (rtUrl) {
    try {
      const g = await get(rtUrl);
      out.runtimeWindow = around(g.text, '.v1.', 250, 450);
      const lazy = chunkUrls(g.text); out.lazyChunks = lazy.length;
      lazy.forEach(add);
    } catch (e) { out.runtimeError = errOf(e); }
  }
  out.totalUrls = urls.length; out.from = from; out.n = n;
  const batch = urls.slice(from, from + n);
  const hits = [], failed = [];
  let quiet = 0;
  await Promise.all(batch.map(async u => {
    try {
      const g = await get(u);
      if (!g.r.ok) { failed.push(g.r.status + ' ' + u.slice(ORIGIN.length)); return; }
      const api = tokensAfter(g.text, '/api/', 15), ashx = windows(g.text, '.ashx', 3, 70), mp = tokensAfter(g.text, 'map_', 12, 30);
      if (api.length || ashx.length || mp.length) hits.push({ u: u.slice(ORIGIN.length), bytes: g.text.length, api, ashx, map_: mp });
      else quiet++;
    } catch (e) { failed.push(errOf(e) + ' ' + u.slice(ORIGIN.length)); }
  }));
  out.ok = true; out.scanned = batch.length; out.quiet = quiet; out.failed = failed.slice(0, 10); out.hits = hits;
  out.next = from + n < urls.length ? `/heat-test?step=scan&from=${from + n}` : 'all scripts scanned';
  return out;
}

async function stepLayout(q) {
  const chunk = /^\/assets\/dist\/[A-Za-z0-9_.\/-]{1,60}\.js$/.test(q.get('chunk') || '') ? q.get('chunk') : '/assets/dist/6178.v1.24ec063e.js';
  const needles = ['/api/maps/base', '/api/map_sparklines', '/api/maps/counts', '/api/map_perf_groups'];
  const ts = (q.get('t') || 'sec,sec_ndx,sec_all,futures,themes').split(',').map(x => x.trim()).filter(x => /^[a-z0-9_]{1,20}$/i.test(x)).slice(0, 8);
  const [code, base] = await Promise.all([
    (async () => {
      try {
        const g = await get(ORIGIN + chunk);
        if (!g.r.ok) return { status: g.r.status };
        const w = {};
        for (const n of needles) w[n] = windows(g.text, n, 2, 350);
        return w;
      } catch (e) { return { error: errOf(e) }; }
    })(),
    Promise.all(ts.map(async t => {
      try {
        const g = await get(`${ORIGIN}/api/maps/base/${t}`);
        const o = { t, status: g.r.status, ms: g.ms, contentType: g.r.headers.get('content-type'), blocked: botCheck(g.text) };
        return g.r.ok ? { ...o, ...summarise(g.text, 700) } : { ...o, head: g.text.slice(0, 200) };
      } catch (e) { return { t, error: errOf(e) }; }
    })),
  ]);
  return { step: 'layout', chunk, code, base, note: 'identical bytes for two names means the name is ignored and the S&P 500 comes back' };
}

async function stepGet(q) {
  const path = q.get('path') || '';
  if (!/^\/(api\/[A-Za-z0-9_.\/-]{1,80}|[A-Za-z0-9_-]{1,40}\.ashx)(\?[A-Za-z0-9_=&,.%-]{0,160})?$/.test(path) || path.includes('..')) {
    return { step: 'get', ok: false, error: 'path must be /api/... or /name.ashx on finviz.com, letters, digits and _ - . / only' };
  }
  try {
    const g = await get(ORIGIN + path);
    const o = { step: 'get', url: ORIGIN + path, status: g.r.status, ms: g.ms, contentType: g.r.headers.get('content-type'), blocked: botCheck(g.text) };
    return { ...o, ...summarise(g.text), head: g.text.slice(0, 800) };
  } catch (e) { return { step: 'get', ok: false, error: errOf(e) }; }
}

export async function heatProbe(reqUrl, now = Date.now()) {
  const u = new URL(reqUrl), q = u.searchParams, key = u.search;
  if (state.body && state.key === key && now - state.at < MEMO) return state.body;
  if (state.at && now - state.at < GAP) return JSON.stringify({ ok: false, error: 'probe is limited to one run per 20 s', retry_in_s: Math.ceil((GAP - (now - state.at)) / 1000) });
  state.at = now; state.key = key; state.body = null;
  const step = q.get('step') || 'page';
  let out;
  try { out = step === 'data' ? await stepData(q) : step === 'uni' ? await stepUni() : step === 'get' ? await stepGet(q) : step === 'scan' ? await stepScan(q) : step === 'layout' ? await stepLayout(q) : await stepPage(q); }
  catch (e) { out = { step, ok: false, error: errOf(e) }; }
  state.body = JSON.stringify(out);
  return state.body;
}

export function _reset() { state.at = 0; state.key = null; state.body = null; }   // for tests
