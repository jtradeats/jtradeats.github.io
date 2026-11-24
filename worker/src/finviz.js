// Finviz news scrape TEST (diagnostic only, nothing on the page uses it yet).
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
