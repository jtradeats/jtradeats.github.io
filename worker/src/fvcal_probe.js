// fvcal_probe.js: TEST ONLY, read only. One request to finviz.com/calendar/economic at most every 60 s.
// Purpose: find out, from the Worker's own network address, whether Finviz answers the calendar page and what its markup looks like,
// so the real parser can be written from the real HTML (the same method as /finviz-test for the news page, 24 Nov).
// Route: GET /fvcal-test            this week (Monday, New York date)
//        GET /fvcal-test?dateFrom=2026-11-23   a given Monday
//        GET /fvcal-test?raw=1      adds longer raw HTML windows around three rows
// Remove the route and this file once /fvcal replaces them.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://finviz.com/calendar/economic?dateFrom=';
const GAP = 60000;
const memo = { key: null, at: 0, body: null };

// Monday of the current New York week. A fixed UTC-5 is close enough for a default (the page also takes ?dateFrom=).
function mondayEt(now) {
  const d = new Date(now - 5 * 3600e3), dow = (d.getUTCDay() + 6) % 7;   // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

// A window of the page around the first place a phrase appears (the start is moved back to the opening of the row).
function around(html, phrase, before, after) {
  const i = html.indexOf(phrase);
  if (i < 0) return null;
  let s = Math.max(0, i - before);
  const tr = html.lastIndexOf('<tr', i);
  if (tr >= 0 && i - tr < before * 2) s = tr;
  return html.slice(s, Math.min(html.length, i + after));
}

export async function fvCalProbe(reqUrl, now = Date.now()) {
  const q = new URL(reqUrl).searchParams;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('dateFrom') || '') ? q.get('dateFrom') : mondayEt(now);
  const raw = q.get('raw') !== null && q.get('raw') !== '0';
  const key = from + (raw ? '|raw' : '');
  if (memo.body && memo.key === key && now - memo.at < GAP) return memo.body;
  if (memo.at && now - memo.at < GAP) {   // another page asked less than a minute ago: do not hit Finviz again
    return JSON.stringify({ ok: false, error: 'probe is limited to one request per 60 s', retry_in_s: Math.ceil((GAP - (now - memo.at)) / 1000) });
  }
  const t0 = Date.now(), out = { ok: false, url: BASE + from, dateFrom: from };
  try {
    const r = await fetch(BASE + from, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
    const html = await r.text();
    out.status = r.status; out.ms = Date.now() - t0; out.bytes = html.length;
    out.contentType = r.headers.get('content-type'); out.finalUrl = r.url;
    out.blocked = /Just a moment|cf-chl|Attention Required|captcha/i.test(html.slice(0, 4000));   // a bot-check page instead of the calendar
    out.ok = r.ok && !out.blocked;
    out.counts = { table: (html.match(/<table/gi) || []).length, tr: (html.match(/<tr/gi) || []).length, td: (html.match(/<td/gi) || []).length, scriptJson: (html.match(/<script[^>]+type="application\/json"/gi) || []).length };
    // the rows the dashboard misses on 25 Nov, and two it has (is each one in the HTML at all?)
    const names = ['Core PCE Price Index YoY', 'Durable Goods Orders MoM', 'New Home Sales', 'GDP Growth Rate QoQ 2nd Est', 'GDP Price Index QoQ 2nd Est', 'CB Consumer Confidence', 'Initial Jobless Claims', 'EIA Crude Oil Stocks Change', 'S&amp;P Global', 'ISM'];
    out.has = Object.fromEntries(names.map(n => [n, html.includes(n)]));
    out.sample = around(html, 'Core PCE Price Index YoY', 300, 1200);          // one row with its cells, to read the structure
    out.dayHeader = around(html, 'Wed Nov 25', 200, 700) || around(html, 'Release', 300, 900);   // how a day's table starts
    const sj = html.search(/<script[^>]+type="application\/json"/i);
    if (sj >= 0) out.firstJsonScript = html.slice(sj, sj + 400);
    if (!r.ok || out.blocked) out.head = html.slice(0, 500);
    if (raw) {
      out.raw = { corePceYoY: around(html, 'Core PCE Price Index YoY', 600, 2500), durable: around(html, 'Durable Goods Orders MoM', 600, 2500), newHome: around(html, 'New Home Sales', 600, 2500) };
    }
  } catch (e) {
    out.error = String(e && e.message).slice(0, 200); out.ms = Date.now() - t0;
  }
  memo.key = key; memo.at = now; memo.body = JSON.stringify(out);
  return memo.body;
}
