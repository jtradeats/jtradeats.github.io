// earnings_probe.js (v2): TEST ONLY, read only. One request to a fixed Finviz earnings page at most every 60 s.
// v1 result (27 Nov): finviz.com/calendar/earnings answers 200 in ~280 ms, not blocked; the page shows ONE day (today) as a server-rendered table
// (<tr class="styled-row ..."> with ticker, company, timing, market cap, EPS estimate, EPS actual ...). v2 reads the table properly (headers, cells, timing values)
// and looks for how the page picks another day (links and date parameters), so the real route can ask for tomorrow and the days after.
// Route: GET /earnings-test            candidate 1: finviz.com/calendar/earnings
//        GET /earnings-test?u=2        candidate 2: finviz.com/calendar/earnings?dateFrom=<this Monday, New York date>
//        GET /earnings-test?u=3        candidate 3 (fallback): Finviz screener, earnings today after close, biggest market cap first
//        GET /earnings-test?raw=1      adds the page's own settings (the JSON block) and raw row markup
// The address is chosen from this fixed list only; this is never a proxy for other pages.
// Remove the route and this file once /earnings replaces them.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const GAP = 60000;
const memo = { key: null, at: 0, body: null };

function mondayEt(now) {
  const d = new Date(now - 5 * 3600e3), dow = (d.getUTCDay() + 6) % 7;   // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}
function candidate(u, now) {
  if (u === '2') return 'https://finviz.com/calendar/earnings?dateFrom=' + mondayEt(now);
  if (u === '3') return 'https://finviz.com/screener.ashx?v=111&f=earningsdate_todayafter&o=-marketcap';
  return 'https://finviz.com/calendar/earnings';
}
const txt = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function around(html, phrase, before, after) {
  const i = typeof phrase === 'string' ? html.indexOf(phrase) : html.search(phrase);
  if (i < 0) return null;
  return html.slice(Math.max(0, i - before), Math.min(html.length, i + after));
}

export async function earningsProbe(reqUrl, now = Date.now()) {
  const q = new URL(reqUrl).searchParams;
  const u = /^[1-3]$/.test(q.get('u') || '') ? q.get('u') : '1';
  const raw = q.get('raw') !== null && q.get('raw') !== '0';
  const url = candidate(u, now), key = u + (raw ? '|raw' : '');
  if (memo.body && memo.key === key && now - memo.at < GAP) return memo.body;
  if (memo.at && now - memo.at < GAP) {
    return JSON.stringify({ ok: false, error: 'probe is limited to one request per 60 s', retry_in_s: Math.ceil((GAP - (now - memo.at)) / 1000) });
  }
  const t0 = Date.now(), out = { ok: false, candidate: u, url };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
    const html = await r.text();
    out.status = r.status; out.ms = Date.now() - t0; out.bytes = html.length; out.finalUrl = r.url; out.cfMitigated = r.headers.get('cf-mitigated');
    out.title = txt((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 160);
    out.blocked = /Just a moment|cf-chl|Attention Required|captcha/i.test(html.slice(0, 4000));
    out.ok = r.ok && !out.blocked;

    // the table: header cells, then every body row's cells as plain text
    out.headers = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => txt(m[1])).slice(0, 24);
    const rows = [];
    for (const m of html.matchAll(/<tr\b[^>]*styled-row[^>]*>([\s\S]*?)<\/tr>/gi)) rows.push([...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1])));
    out.rows = rows.length;
    out.firstRows = rows.slice(0, 6);
    const timing = {};
    for (const c of rows) { const k = c[2] || '(none)'; timing[k] = (timing[k] || 0) + 1; }
    out.timingValues = timing;                       // what the third column says for each row: AMC, BMO, or something else

    // how the page picks another day: links to the calendar and anything that looks like a date parameter
    const links = new Set();
    for (const m of html.matchAll(/href="([^"]*calendar\/earnings[^"]*)"/gi)) links.add(m[1].replace(/&amp;/g, '&'));
    out.calLinks = [...links].slice(0, 40);
    out.paramHints = [...html.matchAll(/dateFrom|dateTo|[?&]date=|data-date=|data-day=/g)].slice(0, 6).map(m => html.slice(Math.max(0, m.index - 80), m.index + 120).replace(/\s+/g, ' '));

    // the page's own settings block (small values only)
    const sj = html.indexOf('data-ssr-props');
    if (sj >= 0) {
      const a = html.indexOf('>', sj) + 1, b = html.indexOf('</script>', a);
      try {
        const props = JSON.parse(html.slice(a, b)), short = {};
        for (const [k, v] of Object.entries(props)) { const s = JSON.stringify(v); if (s !== undefined && s.length <= 200) short[k] = v; }
        out.propsKeys = Object.keys(props); out.propsShort = short;
      } catch (e) { out.propsError = String(e.message).slice(0, 100); out.propsHead = html.slice(a, a + 600); }
    }
    if (!r.ok || out.blocked) out.head = html.slice(0, 500);
    if (raw) out.rawFirstRow = around(html, /<tr\b[^>]*styled-row/i, 0, 3500);

    out.verdict = !r.ok ? `failed: HTTP ${r.status}`
      : out.blocked || out.cfMitigated ? 'challenge page: Finviz is blocking this Worker'
      : rows.length >= 1 ? `readable: ${rows.length} row(s) in the HTML for the page's default day, a parser is possible`
      : 'page loads but no styled rows found: try ?u=2 or ?u=3 and send ?raw=1 output';
  } catch (e) {
    out.error = String(e && e.message).slice(0, 200); out.ms = Date.now() - t0;
    out.verdict = 'request failed (timeout or network)';
  }
  memo.key = key; memo.at = now; memo.body = JSON.stringify(out, null, 1);
  return memo.body;
}
