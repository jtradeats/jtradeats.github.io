// earnings_probe.js (v3): TEST ONLY, read only. At most one request to Finviz every 60 s, always to finviz.com/calendar/earnings.
// Findings so far (27 Nov): the page answers the Worker (200, ~300 ms, not blocked); the rows are plain HTML (<tr class="styled-row ..."> with 14 cells:
// ticker, company, time (BMO or AMC), market cap, EPS est/act/sur, EPS GAAP est/act/sur, revenue est/act/sur, 1-day change). No date parameter = today only.
// ?dateFrom=<date> works; its links also offer &page=0..2. v3 answers what is still open: which day does dateFrom show, how are the rows ordered,
// how many fit on a page, and is there a way to sort by market cap.
// Route: GET /earnings-test                      the page with no parameter (today)
//        GET /earnings-test?d=2026-12-01         that day (only dates from 30 days back to 45 days ahead are accepted)
//        GET /earnings-test?d=2026-12-01&page=1  the same day, page 1 (0 to 9)
// The address is always finviz.com/calendar/earnings plus those two checked parameters; this is never a proxy for other pages.
// Remove the route and this file once /earnings replaces them.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const GAP = 60000;
const BASE = 'https://finviz.com/calendar/earnings';
const memo = { key: null, at: 0, body: null };

const txt = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const capNum = s => { const m = /^\$?([\d,.]+)\s*([KMBT]?)/i.exec(String(s || '')); if (!m) return 0; return parseFloat(m[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()] || 1); };
const dayMs = iso => Date.parse(iso + 'T12:00:00Z');
function around(html, phrase, before, after) {
  const i = typeof phrase === 'string' ? html.indexOf(phrase) : html.search(phrase);
  if (i < 0) return null;
  return html.slice(Math.max(0, i - before), Math.min(html.length, i + after));
}

export async function earningsProbe(reqUrl, now = Date.now()) {
  const q = new URL(reqUrl).searchParams;
  const dq = q.get('d') || '', page = /^[0-9]$/.test(q.get('page') || '') ? q.get('page') : '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dq) && Math.abs(dayMs(dq) - now) < 45 * 864e5 && dayMs(dq) - now > -30 * 864e5 ? dq : '';
  const url = d ? `${BASE}?dateFrom=${d}${page ? '&page=' + page : ''}` : BASE;
  const key = url;
  if (memo.body && memo.key === key && now - memo.at < GAP) return memo.body;
  if (memo.at && now - memo.at < GAP) {
    return JSON.stringify({ ok: false, error: 'probe is limited to one request per 60 s', retry_in_s: Math.ceil((GAP - (now - memo.at)) / 1000) });
  }
  const t0 = Date.now(), out = { ok: false, url };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
    const html = await r.text();
    out.status = r.status; out.ms = Date.now() - t0; out.bytes = html.length;
    out.blocked = /Just a moment|cf-chl|Attention Required|captcha/i.test(html.slice(0, 4000));
    out.ok = r.ok && !out.blocked;

    const rows = [];
    for (const m of html.matchAll(/<tr\b[^>]*styled-row[^>]*>([\s\S]*?)<\/tr>/gi)) rows.push([...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c => txt(c[1])));
    out.rows = rows.length;
    const timing = {};
    for (const c of rows) { const k = c[2] || '(none)'; timing[k] = (timing[k] || 0) + 1; }
    out.timingValues = timing;
    // the order the page lists them in: ticker | time | market cap
    out.order = rows.slice(0, 80).map(c => `${String(c[0]).replace(/^\S\s/, '')}|${c[2]}|${c[3]}`);
    out.topByCap = rows.map(c => [String(c[0]).replace(/^\S\s/, ''), c[2], c[3], c[4]]).sort((a, b) => capNum(b[2]) - capNum(a[2])).slice(0, 10);

    // paging
    out.pager = [...html.matchAll(/<a\b[^>]*title="(Go to [^"]*)"[^>]*>/gi)].slice(0, 8).map(m => ({ title: m[1], href: (m[0].match(/href="([^"]*)"/) || [])[1], disabled: /disabled=""/.test(m[0]) }));
    out.pageLinks = [...new Set([...html.matchAll(/href="([^"]*calendar\/earnings[^"]*page=[^"]*)"/gi)].map(m => m[1].replace(/&amp;/g, '&')))].slice(0, 12);
    // sorting: the header cells for Time and Market Cap, and any link that mentions sort/order
    out.thTime = around(html, /<th\b[^>]*>\s*(?:<[^>]+>\s*)*Time\b/i, 0, 600);
    out.thCap = around(html, /<th\b[^>]*>\s*(?:<[^>]+>\s*)*Market Cap\b/i, 0, 600);
    out.sortLinks = [...new Set([...html.matchAll(/href="([^"]*(?:sort|order)[^"]*)"/gi)].map(m => m[1].replace(/&amp;/g, '&')))].slice(0, 10);
    // which day the page shows: the page's own url setting and how the day tabs look (the selected one differs)
    const sj = html.indexOf('data-ssr-props');
    if (sj >= 0) { const a = html.indexOf('>', sj) + 1, b = html.indexOf('</script>', a); try { const p = JSON.parse(html.slice(a, b)); out.props = { url: p.url, today: p.today }; } catch (e) { /* ignore */ } }
    const tabs = [...html.matchAll(/<a\b[^>]*href="\/calendar\/earnings\?dateFrom=(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ date: m[1], label: txt(m[2]), raw: m[0] }));
    out.dayTabs = tabs.map(t => `${t.date} ${t.label}`).slice(0, 14);
    const want = tabs.find(t => t.date === (d || (out.props && out.props.today)) && /^(Mon|Tue|Wed|Thu|Fri)/i.test(t.label)) || tabs[0];
    const other = tabs.find(t => want && t.date !== want.date && /^(Mon|Tue|Wed|Thu|Fri)/i.test(t.label));
    if (want) out.tabRequested = want.raw.slice(0, 700);
    if (other) out.tabOther = other.raw.slice(0, 700);
    if (!r.ok || out.blocked) out.head = html.slice(0, 500);
    out.verdict = !r.ok ? `failed: HTTP ${r.status}` : out.blocked ? 'challenge page: Finviz is blocking this Worker' : `${rows.length} row(s): ${JSON.stringify(timing)}`;
  } catch (e) {
    out.error = String(e && e.message).slice(0, 200); out.ms = Date.now() - t0;
    out.verdict = 'request failed (timeout or network)';
  }
  memo.key = key; memo.at = now; memo.body = JSON.stringify(out, null, 1);
  return memo.body;
}
