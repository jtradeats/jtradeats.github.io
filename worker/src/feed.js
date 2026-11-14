// DeItaone wire via the public Telegram preview (t.me/s/WalterBloomberg): plan 1.5, decisions D46 to D49.
// GET /feed -> the latest posts (rolling window) plus poll health. An unofficial mirror: ultrafast, unconfirmed.
// Display only. No alerts here (plan 4.4). Rendering on the page is textContent only.
//
// Parsing is kept apart from fetching: parseTelegram() takes the page HTML and a "runner" that feeds it through an
// HTMLRewriter. In the Worker the runner uses the built-in HTMLRewriter; the tests plug in the WASM build of the same engine.

export const FEED_CHANNEL = 'WalterBloomberg';
const FEED_URL = `https://t.me/s/${FEED_CHANNEL}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FEED_TTL = 10000;          // reuse a poll for 10 s: at most ~6 upstream requests a minute however many tabs are open
const FEED_RETRY = 15000;        // after a failed poll
const FEED_RETRY_429 = 60000;    // after HTTP 429, leave Telegram alone for longer
const FEED_TIMEOUT = 4000;       // per upstream request
const FEED_DEADLINE = 2500;      // a request waits at most this long for a fresh poll, then answers from the window
const FEED_KEEP = 50;            // posts kept in the rolling window
const FEED_STALE = 90000;        // status "stale" if the last good poll is older than this
const KV_KEY = 'feed:window';
const KV_GAP = 15 * 60000;       // at most one snapshot write per 15 min: <= 96 writes a day (budget: ~100)

// ---- parsing ----
const MEDIA_SEL = [
  '.tgme_widget_message_photo_wrap', '.tgme_widget_message_video_player', '.tgme_widget_message_roundvideo_player',
  '.tgme_widget_message_document_wrap', '.tgme_widget_message_sticker_wrap', '.tgme_widget_message_poll',
  '.tgme_widget_message_voice',
].join(',');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {   // HTMLRewriter hands over text with entities still encoded
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (_) { return m; }
    }
    const v = ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const NOISE_LINE = new RegExp(`^\\(?@${FEED_CHANNEL}\\)?$|^https?://t\\.me/${FEED_CHANNEL}(/\\d+)?/?$`, 'i');
export function cleanText(raw) {
  const lines = decodeEntities(raw).replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
  let s = lines.filter(l => !NOISE_LINE.test(l.trim())).join('\n');
  s = s.replace(new RegExp(`\\s*\\(@${FEED_CHANNEL}\\)\\s*$`, 'i'), '');   // signature at the end of the last line
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s.replace(/^\*+\s*/, '');                                         // leading "*" of the wire's headline style
}

// Registers the handlers on any HTMLRewriter (Workers or WASM) and fills `posts`. One entry per [data-post] element.
export function attachParser(rw, posts) {
  let cur = null, inText = false, skip = false;
  rw.on('[data-post]', {
    element(el) {
      // only this channel's own posts: a reply quote or a forward can carry a data-post of another message
      const m = new RegExp(`^${FEED_CHANNEL}/(\\d+)$`, 'i').exec(el.getAttribute('data-post') || '');
      if (!m) return;                       // not a post of this channel: leave the current post alone
      inText = false; skip = false;
      cur = { id: +m[1], t: null, raw: '', media: false };
      posts.push(cur);
    },
  });
  // the quoted message of a reply has the same text class as the post itself: keep it out of the post's text
  rw.on('.tgme_widget_message_reply, .tgme_widget_message_forwarded_from', {
    element(el) { skip = true; el.onEndTag(() => { skip = false; }); },
  });
  rw.on('.tgme_widget_message_text', {
    element(el) { if (!cur || skip) return; inText = true; el.onEndTag(() => { inText = false; }); },
    text(c) { if (cur && inText && !skip) cur.raw += c.text; },   // also fires for text inside <a>, <b>, <i>
  });
  rw.on('.tgme_widget_message_text br', { element() { if (cur && inText && !skip) cur.raw += '\n'; } });
  rw.on('.tgme_widget_message_date time', {
    element(el) {
      if (!cur || cur.t != null) return;
      const ms = Date.parse(el.getAttribute('datetime') || '');
      if (Number.isFinite(ms)) cur.t = ms;     // the post's own time, not the poll time
    },
  });
  rw.on(MEDIA_SEL, { element() { if (cur) cur.media = true; } });
  return rw;
}

async function runWorkers(html, attach) {
  const rw = new HTMLRewriter();
  attach(rw);
  await rw.transform(new Response(html)).arrayBuffer();
}

let RUNNER = runWorkers;
export function _useRunner(fn) { RUNNER = fn || runWorkers; }   // tests plug in the WASM HTMLRewriter

// html -> [{id, t, text, url, media}] newest first
export async function parseTelegram(html, run = runWorkers) {
  const raw = [];
  await run(html, rw => attachParser(rw, raw));
  const seen = new Set(), out = [];
  for (const p of raw) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, t: p.t, text: cleanText(p.raw), url: `https://t.me/${FEED_CHANNEL}/${p.id}`, media: p.media });
  }
  return out.sort((a, b) => b.id - a.id);
}

export function mergePosts(win, incoming, keep = FEED_KEEP) {   // -> { posts, added }
  const byId = new Map(win.map(p => [p.id, p]));
  let added = 0;
  for (const p of incoming) { if (!byId.has(p.id)) added++; byId.set(p.id, p); }
  return { posts: [...byId.values()].sort((a, b) => b.id - a.id).slice(0, keep), added };
}

// ---- state: lives in the isolate; the page never makes Telegram wait for more than one poll at a time ----
const S = { posts: [], at: 0, okAt: 0, failAt: 0, err: null, rate: false, httpStatus: null, parsed: 0, withTime: 0,
  parseMs: null, bytes: 0, sample: null, inflight: null, seeded: false, lastKv: 0 };
export const _state = S;   // for tests

function sampleOf(html) {
  const i = html.indexOf('tgme_widget_message');
  return html.slice(Math.max(0, i - 200), Math.max(0, i - 200) + 1700);
}

async function pollOnce(env) {
  const fail = (status, msg, rate) => { S.at = S.failAt = Date.now(); S.err = String(msg).slice(0, 200); S.rate = !!rate; S.httpStatus = status; };
  let res;
  try {
    res = await fetch(FEED_URL, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(FEED_TIMEOUT) });
  } catch (e) { return fail(null, `fetch failed: ${e.message}`); }
  if (!res.ok) return fail(res.status, `HTTP ${res.status} from t.me`, res.status === 429);
  let html;
  try { html = await res.text(); } catch (e) { return fail(res.status, `read failed: ${e.message}`); }
  let posts;
  const p0 = Date.now();
  try { posts = await parseTelegram(html, RUNNER); } catch (e) { S.sample = sampleOf(html); return fail(res.status, `parser error: ${e.message}`); }
  S.parseMs = Date.now() - p0;   // Workers' clock only moves on I/O, so this can read 0 for pure CPU time
  S.bytes = html.length;
  if (!posts.length) { S.sample = sampleOf(html); return fail(res.status, 'parsed 0 posts: the page markup may have changed'); }
  const now = Date.now(), m = mergePosts(S.posts, posts);
  S.posts = m.posts;
  S.at = S.okAt = now; S.failAt = 0; S.err = null; S.rate = false; S.httpStatus = res.status;
  S.parsed = posts.length; S.withTime = posts.filter(p => p.t != null).length;
  if (S.parsed === S.withTime) S.sample = null;
  if (m.added && env && env.MARKET_KV && now - S.lastKv > KV_GAP) {
    S.lastKv = now;
    try { await env.MARKET_KV.put(KV_KEY, JSON.stringify({ at: now, posts: S.posts })); } catch (_) { /* ignore */ }
  }
}

async function seed(env) {
  S.seeded = true;
  if (S.posts.length || !env || !env.MARKET_KV) return;
  try {
    const snap = await env.MARKET_KV.get(KV_KEY, 'json');
    if (snap && Array.isArray(snap.posts)) S.posts = snap.posts.slice(0, FEED_KEEP);   // shown as stale until the first poll succeeds
  } catch (_) { /* KV unavailable: carry on without it */ }
}

function statusNow(now) {
  if (!S.okAt || S.failAt) return 'broken';          // never polled OK, or the last poll failed
  return now - S.okAt > FEED_STALE ? 'stale' : 'ok';
}

export function feedHealth(now = Date.now()) {
  const newest = S.posts[0] || null;
  return { status: statusNow(now), parsed: S.parsed, newest_id: newest ? newest.id : null,
    newest_age_s: newest && newest.t ? Math.round((now - newest.t) / 1000) : null,
    poll_age_s: S.okAt ? Math.round((now - S.okAt) / 1000) : null, window: S.posts.length, parse_ms: S.parseMs, http: S.httpStatus };
}

function view(now, debug) {
  const newest = S.posts[0] || null;
  const out = {
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    now,
    status: statusNow(now),                       // ok | stale | broken (judged by the poll, never by post age: gaps of hours are normal)
    error: S.failAt ? S.err : null,
    health: { pollAt: S.at || null, okAt: S.okAt || null, httpStatus: S.httpStatus, parsed: S.parsed, withTime: S.withTime,
      newestId: newest ? newest.id : null, newestT: newest ? newest.t : null, parseMs: S.parseMs, bytes: S.bytes, rate: S.rate },
    posts: S.posts.map(({ id, t, text, url, media }) => ({ id, t, text, url, media })),
  };
  if (debug) out.sample = S.sample;
  return JSON.stringify(out);
}

export async function getFeed(env, ctx, opts = {}) {
  if (!S.seeded) await seed(env);
  const now = Date.now();
  const gap = S.failAt ? (S.rate ? FEED_RETRY_429 : FEED_RETRY) : FEED_TTL;
  if (now - S.at >= gap) {
    if (!S.inflight) S.inflight = pollOnce(env).catch(e => { S.at = S.failAt = Date.now(); S.err = String(e.message).slice(0, 200); }).finally(() => { S.inflight = null; });
    const p = S.inflight;
    if (ctx) ctx.waitUntil(p);
    await Promise.race([p, new Promise(r => setTimeout(r, FEED_DEADLINE))]);
  }
  return view(Date.now(), !!opts.debug);
}
