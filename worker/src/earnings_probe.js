// earnings_probe.js: TEST ONLY, read only. One request to a fixed Finviz earnings page at most every 60 s.
// Purpose: find out, from the Worker's own network address, whether Finviz answers its earnings calendar, and what the markup looks like
// (are the rows plain HTML or inside JSON? is a before-open / after-close marker there? market cap? EPS estimate?), so the real parser
// can be written from the real page (the same method as /fvcal-test and /finviz-test).
// Route: GET /earnings-test            candidate 1: finviz.com/calendar/earnings
//        GET /earnings-test?u=2        candidate 2: finviz.com/calendar/earnings?dateFrom=<this Monday, New York date>
//        GET /earnings-test?u=3        candidate 3 (fallback): Finviz screener, earnings today after close, biggest market cap first
//        GET /earnings-test?raw=1      adds longer raw windows (row markup, JSON around "earnings")
// The address is chosen from this fixed list only; this is never a proxy for other pages.
// Remove the route and this file once /earnings replaces them.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const GAP = 60000;
const memo = { key: null, at: 0, body: null };

// Monday of the current New York week. A fixed UTC-5 is close enough for a probe.
function mondayEt(now) {
  const d = new Date(now - 5 * 3600e3), dow = (d.getUTCDay() + 6) % 7;   // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

function candidate(u, now) {
  if (u === '2') return 'https://finviz.com/calendar/earnings?dateFrom=' + mondayEt(now);
  if (u === '3') return 'https://finviz.com/screener.ashx?v=111&f=earningsdate_todayafter&o=-marketcap';
  return 'https://finviz.com/calendar/earnings';
}

// A window of the page around the first place a phrase appears (the start is moved back to the opening of the row when one is close).
function around(html, phrase, before, after) {
  const i = typeof phrase === 'string' ? html.indexOf(phrase) : html.search(phrase);
  if (i < 0) return null;
  let s = Math.max(0, i - before);
  const tr = html.lastIndexOf('<tr', i);
  if (tr >= 0 && i - tr < before * 2) s = tr;
  return html.slice(s, Math.min(html.length, i + after));
}

export async function earningsProbe(reqUrl, now = Date.now()) {
  const q = new URL(reqUrl).searchParams;
  const u = /^[1-3]$/.test(q.get('u') || '') ? q.get('u') : '1';
  const raw = q.get('raw') !== null && q.get('raw') !== '0';
  const url = candidate(u, now), key = u + (raw ? '|raw' : '');
  if (memo.body && memo.key === key && now - memo.at < GAP) return memo.body;
  if (memo.at && now - memo.at < GAP) {   // another page asked less than a minute ago: do not hit Finviz again
    return JSON.stringify({ ok: false, error: 'probe is limited to one request per 60 s', retry_in_s: Math.ceil((GAP - (now - memo.at)) / 1000) });
  }
  const t0 = Date.now(), out = { ok: false, candidate: u, url };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
    const html = await r.text();
    out.status = r.status; out.ms = Date.now() - t0; out.bytes = html.length;
    out.contentType = r.headers.get('content-type'); out.finalUrl = r.url; out.redirected = r.redirected;
    out.cfMitigated = r.headers.get('cf-mitigated');
    out.title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    out.blocked = /Just a moment|cf-chl|Attention Required|captcha/i.test(html.slice(0, 4000));   // a bot-check page instead of the calendar
    out.ok = r.ok && !out.blocked;
    out.counts = { table: (html.match(/<table/gi) || []).length, tr: (html.match(/<tr/gi) || []).length, td: (html.match(/<td/gi) || []).length,
      scriptJson: (html.match(/<script[^>]+type="application\/json"/gi) || []).length, nextData: /__NEXT_DATA__/.test(html) };
    // is each of these in the HTML at all? (big index names, and the words that would mark a before-open / after-close column)
    const words = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'WMT', 'COST', 'Before', 'After', 'BMO', 'AMC', 'Market Cap', 'Estimate', 'Expected', 'Actual', 'Surprise'];
    out.has = Object.fromEntries(words.map(w => [w, html.includes(w)]));
    // a day header such as "Mon Nov 30" or "Tue Dec 1", and the first table row after it
    const dayRe = /(Mon|Tue|Wed|Thu|Fri) (Nov|Dec|Jan) \d{1,2}/;
    out.dayHeader = around(html, dayRe, 200, 900);
    out.firstRow = around(html, /<tr[^>]*>\s*<td/i, 0, 1400);
    const sj = html.search(/<script[^>]+type="application\/json"/i);
    if (sj >= 0) out.firstJsonScript = html.slice(sj, sj + 400);
    if (!r.ok || out.blocked) out.head = html.slice(0, 500);
    if (raw) {
      out.raw = { aroundTicker: around(html, /\b(AAPL|MSFT|NVDA|AMZN|GOOGL|META)\b/, 700, 2000), aroundEarningsJson: around(html, /"earnings[A-Za-z]*"\s*:/, 300, 2500) };
    }
    out.verdict = !r.ok ? `failed: HTTP ${r.status}`
      : out.blocked || out.cfMitigated ? 'challenge page: Finviz is blocking this Worker'
      : out.counts.tr >= 15 ? 'readable: table rows are in the HTML, a real parser is possible'
      : out.counts.nextData || out.counts.scriptJson ? 'page loads but the rows look to be inside JSON: send ?raw=1 output'
      : 'page loads but no table rows: probably drawn by JavaScript; try ?u=2 or ?u=3 and send ?raw=1 output';
  } catch (e) {
    out.error = String(e && e.message).slice(0, 200); out.ms = Date.now() - t0;
    out.verdict = 'request failed (timeout or network)';
  }
  memo.key = key; memo.at = now; memo.body = JSON.stringify(out, null, 1);
  return memo.body;
}
