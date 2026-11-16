// Telegram wires via the public preview (t.me/s/<channel>): plan 1.5, decisions D46 to D49 and D76 to D79.
//   GET /feed                      -> both channels in one answer (plan P1): the DeItaone view at the top level (as before) and
//                                     the FinancialJuice view under "fj"; posts that start with the red exclamation mark carry hot:true
//   GET /feed?ch=FinancialJuice    -> that one channel's view alone (gates, debugging)
// Each view has the latest posts (rolling window) plus poll health. An unofficial mirror: ultrafast, unconfirmed.
// Display only. The page decides what raises a toast (plan 4.4: FinancialJuice, hot posts only). Rendering on the page is textContent only.
//
// Parsing is kept apart from fetching: parseTelegram() takes the page HTML and a "runner" that feeds it through an
// HTMLRewriter. In the Worker the runner uses the built-in HTMLRewriter; the tests plug in the WASM build of the same engine.

export const FEED_CHANNEL = 'WalterBloomberg';   // the default channel: every export below behaves as before when no channel is given

// One entry per verified channel (D47: scraping is allowed for these only; an unknown name is refused by the route).
//   hot:  the channel flags important posts with a leading red exclamation mark -> the post gets hot:true and the mark is removed from the text
//   tail: a trailing source tag the channel adds to every post (FinancialJuice ends each post with a "|FJ" link)
//   key: the name of the channel's block in the combined answer ('' = the top level)
//   kv / kvGap: the KV key of the snapshot and the minimum gap between two writes (15 min each: at most 96 writes a day per channel, D79)
export const CHANNELS = {
  WalterBloomberg: { name: 'WalterBloomberg', key: '', hot: false, tail: null, kv: 'feed:window', kvGap: 15 * 60000 },
  FinancialJuice: { name: 'FinancialJuice', key: 'fj', hot: true, tail: /\s*\|\s*FJ\s*$/i, kv: 'feed:window:FinancialJuice', kvGap: 15 * 60000 },
};
const chOf = ch => CHANNELS[ch] || { name: ch, key: ch, hot: false, tail: null, kv: `feed:window:${ch}`, kvGap: 15 * 60000 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FEED_TTL = 10000;          // reuse a poll for 10 s: at most ~6 upstream requests a minute per channel however many tabs are open
const FEED_RETRY = 15000;        // after a failed poll
const FEED_RETRY_429 = 60000;    // after HTTP 429, leave Telegram alone for longer
const FEED_TIMEOUT = 4000;       // per upstream request
const FEED_DEADLINE = 2500;      // a request waits at most this long for a fresh poll, then answers from the window
const FEED_KEEP = 50;            // posts kept in the rolling window
const FEED_STALE = 90000;        // status "stale" if the last good poll is older than this
const FEED_STAGGER = 350;        // the second channel's poll starts this much later, so the two requests to Telegram never go out together

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

const noiseLine = ch => new RegExp(`^\\(?@${ch}\\)?$|^https?://t\\.me/${ch}(/\\d+)?/?$`, 'i');
export function cleanText(raw, ch = FEED_CHANNEL) {
  const c = chOf(ch), noise = noiseLine(c.name);
  const lines = decodeEntities(raw).replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
  let s = lines.filter(l => !noise.test(l.trim())).join('\n');
  s = s.replace(new RegExp(`\\s*\\(@${c.name}\\)\\s*$`, 'i'), '');   // signature at the end of the last line
  if (c.tail) s = s.replace(c.tail, '');                              // the channel's own tag ("|FJ")
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s.replace(/^\*+\s*/, '');                                    // leading "*" of the wire's headline style
}

// U+2757 heavy exclamation mark, with or without the emoji variation selector
const HOT_LEAD = /^[\s*]*❗️?\s*/;
// -> { text, hot }. hot = the cleaned text starts with the red exclamation mark (the mark is removed from the text).
// img: the page also showed the mark as an emoji image at the start of the text but the glyph was missing from the text itself.
export function splitHot(text, img = false) {
  const m = HOT_LEAD.exec(text);
  if (m) return { text: text.slice(m[0].length), hot: true };
  return { text, hot: !!img };
}

// Registers the handlers on any HTMLRewriter (Workers or WASM) and fills `posts`. One entry per [data-post] element.
export function attachParser(rw, posts, ch = FEED_CHANNEL) {
  const name = chOf(ch).name, own = new RegExp(`^${name}/(\\d+)$`, 'i');
  let cur = null, inText = false, skip = false;
  rw.on('[data-post]', {
    element(el) {
      // only this channel's own posts: a reply quote or a forward can carry a data-post of another message
      const m = own.exec(el.getAttribute('data-post') || '');
      if (!m) return;                       // not a post of this channel: leave the current post alone
      inText = false; skip = false;
      cur = { id: +m[1], t: null, raw: '', media: false, hotImg: false };
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
  // Telegram draws emoji as <i class="emoji" style="background-image:url(.../E29D97.png)"><b>glyph</b></i>.
  // E29D97 is the UTF-8 byte sequence of U+2757: a second way to see the mark, if the glyph itself is ever left out of the text.
  rw.on('.tgme_widget_message_text i.emoji', {
    element(el) {
      if (!cur || !inText || skip || cur.raw.replace(/[\s*]+/g, '') !== '') return;   // only a mark at the very start counts
      if (/E29D97/i.test(el.getAttribute('style') || '')) cur.hotImg = true;
    },
  });
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

// html -> [{id, t, text, url, media}] newest first. On a hot channel a post that starts with the red mark also has hot:true
// (the key is absent on other posts and on other channels, so DeItaone's output is unchanged).
export async function parseTelegram(html, run = runWorkers, ch = FEED_CHANNEL) {
  const c = chOf(ch), raw = [];
  await run(html, rw => attachParser(rw, raw, c.name));
  const seen = new Set(), out = [];
  for (const p of raw) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    let text = cleanText(p.raw, c.name), hot = false;
    if (c.hot) ({ text, hot } = splitHot(text, p.hotImg));
    const post = { id: p.id, t: p.t, text, url: `https://t.me/${c.name}/${p.id}`, media: p.media };
    if (hot) post.hot = true;
    out.push(post);
  }
  return out.sort((a, b) => b.id - a.id);
}

export function mergePosts(win, incoming, keep = FEED_KEEP) {   // -> { posts, added }
  const byId = new Map(win.map(p => [p.id, p]));
  let added = 0;
  for (const p of incoming) { if (!byId.has(p.id)) added++; byId.set(p.id, p); }   // a re-read post replaces the old copy (edits, hot flag)
  return { posts: [...byId.values()].sort((a, b) => b.id - a.id).slice(0, keep), added };
}

// ---- state: one per channel, lives in the isolate; the page never makes Telegram wait for more than one poll at a time ----
const newState = () => ({ posts: [], at: 0, okAt: 0, failAt: 0, err: null, rate: false, httpStatus: null, parsed: 0, withTime: 0,
  parseMs: null, bytes: 0, sample: null, inflight: null, seeded: false, lastKv: 0, gapId: 0 });
const STATES = { [FEED_CHANNEL]: newState() };
const stateOf = ch => STATES[ch] || (STATES[ch] = newState());
export const _state = STATES[FEED_CHANNEL];   // for tests: the default channel's state, as before
export const _stateOf = stateOf;              // for tests: any channel's state

function sampleOf(html) {
  const i = html.indexOf('tgme_widget_message');
  return html.slice(Math.max(0, i - 200), Math.max(0, i - 200) + 1700);
}

async function pollOnce(env, c, S) {
  const fail = (status, msg, rate) => { S.at = S.failAt = Date.now(); S.err = String(msg).slice(0, 200); S.rate = !!rate; S.httpStatus = status; };
  let res;
  try {
    res = await fetch(`https://t.me/s/${c.name}`, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(FEED_TIMEOUT) });
  } catch (e) { return fail(null, `fetch failed: ${e.message}`); }
  if (!res.ok) return fail(res.status, `HTTP ${res.status} from t.me`, res.status === 429);
  let html;
  try { html = await res.text(); } catch (e) { return fail(res.status, `read failed: ${e.message}`); }
  let posts;
  const p0 = Date.now();
  try { posts = await parseTelegram(html, RUNNER, c.name); } catch (e) { S.sample = sampleOf(html); return fail(res.status, `parser error: ${e.message}`); }
  S.parseMs = Date.now() - p0;   // Workers' clock only moves on I/O, so this can read 0 for pure CPU time
  S.bytes = html.length;
  if (!posts.length) { S.sample = sampleOf(html); return fail(res.status, 'parsed 0 posts: the page markup may have changed'); }
  const now = Date.now(), m = mergePosts(S.posts, posts);
  // a window that does not meet the new page (a cold isolate, or a long pause) may have missed posts in between
  if (S.posts.length && Math.min(...posts.map(p => p.id)) > S.posts[0].id + 1) S.gapId = Math.min(...posts.map(p => p.id));
  S.posts = m.posts;
  S.at = S.okAt = now; S.failAt = 0; S.err = null; S.rate = false; S.httpStatus = res.status;
  S.parsed = posts.length; S.withTime = posts.filter(p => p.t != null).length;
  if (S.parsed === S.withTime) S.sample = null;
  if (m.added && env && env.MARKET_KV && now - S.lastKv > c.kvGap) {
    S.lastKv = now;
    try { await env.MARKET_KV.put(c.kv, JSON.stringify({ at: now, posts: S.posts })); } catch (_) { /* ignore */ }
  }
}

async function seed(env, c, S) {
  S.seeded = true;
  if (S.posts.length || !env || !env.MARKET_KV) return;
  try {
    const snap = await env.MARKET_KV.get(c.kv, 'json');
    if (snap && Array.isArray(snap.posts)) S.posts = snap.posts.slice(0, FEED_KEEP);   // shown as stale until the first poll succeeds
  } catch (_) { /* KV unavailable: carry on without it */ }
}

function statusNow(S, now) {
  if (!S.okAt || S.failAt) return 'broken';          // never polled OK, or the last poll failed
  return now - S.okAt > FEED_STALE ? 'stale' : 'ok';
}

const hotCount = posts => posts.reduce((n, p) => n + (p.hot ? 1 : 0), 0);

export function feedHealth(now = Date.now(), ch = FEED_CHANNEL) {
  const c = chOf(ch), S = stateOf(c.name), newest = S.posts[0] || null;
  const h = { status: statusNow(S, now), parsed: S.parsed, newest_id: newest ? newest.id : null,
    newest_age_s: newest && newest.t ? Math.round((now - newest.t) / 1000) : null,
    poll_age_s: S.okAt ? Math.round((now - S.okAt) / 1000) : null, window: S.posts.length, parse_ms: S.parseMs, http: S.httpStatus };
  if (c.hot) h.hot = hotCount(S.posts);   // 0 for hours in a row can be normal; 0 forever means the mark is no longer detected
  return h;
}

function viewOf(c, S, now, debug) {
  const newest = S.posts[0] || null;
  const out = {
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    now,
    channel: c.name,
    status: statusNow(S, now),                    // ok | stale | broken (judged by the poll, never by post age: gaps of hours are normal)
    error: S.failAt ? S.err : null,
    health: { pollAt: S.at || null, okAt: S.okAt || null, httpStatus: S.httpStatus, parsed: S.parsed, withTime: S.withTime,
      newestId: newest ? newest.id : null, newestT: newest ? newest.t : null, parseMs: S.parseMs, bytes: S.bytes, rate: S.rate },
    posts: S.posts.map(p => { const o = { id: p.id, t: p.t, text: p.text, url: p.url, media: p.media }; if (p.hot) o.hot = true; return o; }),
  };
  if (c.hot) out.health.hot = hotCount(S.posts);
  if (S.gapId && S.posts.some(p => p.id < S.gapId)) out.gap = true;   // the window has a hole: older posts may be missing
  if (debug) out.sample = S.sample;
  return out;
}

// opts: { debug, channel, stagger }. The route validates the channel against CHANNELS before calling.
async function feedObject(env, ctx, opts = {}) {
  const c = chOf(opts.channel || FEED_CHANNEL), S = stateOf(c.name);
  if (!S.seeded) await seed(env, c, S);
  const now = Date.now();
  const gap = S.failAt ? (S.rate ? FEED_RETRY_429 : FEED_RETRY) : FEED_TTL;
  if (now - S.at >= gap) {
    if (!S.inflight) S.inflight = (opts.stagger ? new Promise(r => setTimeout(r, opts.stagger)) : Promise.resolve()).then(() => pollOnce(env, c, S))
      .catch(e => { S.at = S.failAt = Date.now(); S.err = String(e.message).slice(0, 200); }).finally(() => { S.inflight = null; });
    const p = S.inflight;
    if (ctx) ctx.waitUntil(p);
    await Promise.race([p, new Promise(r => setTimeout(r, FEED_DEADLINE))]);
  }
  return viewOf(c, S, Date.now(), !!opts.debug);
}

// The latest posts of one channel for other routes (the calendar's wire actuals, wire.js). poll = false: read the window as it is (seeded from KV on a cold start);
// poll = true: first run a poll like /feed does (the 10 s reuse, the back-off and the 2.5 s deadline all apply, so this never hammers Telegram).
export async function feedWindow(env, ctx, ch, poll) {
  const c = chOf(ch || FEED_CHANNEL), S = stateOf(c.name);
  if (!S.seeded) await seed(env, c, S);
  if (poll) await feedObject(env, ctx, { channel: c.name });
  return { posts: S.posts, status: statusNow(S, Date.now()), okAt: S.okAt || null };
}

// one channel, as a JSON string (the old shape: the DeItaone view by default)
export async function getFeed(env, ctx, opts = {}) { return JSON.stringify(await feedObject(env, ctx, opts)); }

// both channels in one call: the default channel's view at the top level, the others under their key (FinancialJuice: "fj").
// allSettled: one channel failing never takes the other down; its block just says broken.
export async function getFeeds(env, ctx, opts = {}) {
  const names = Object.keys(CHANNELS);
  const rs = await Promise.allSettled(names.map((n, i) => feedObject(env, ctx, { debug: opts.debug, channel: n, stagger: i * FEED_STAGGER })));
  const view = (n, r) => r.status === 'fulfilled' ? r.value
    : { updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), now: Date.now(), channel: n, status: 'broken', error: String(r.reason && r.reason.message || r.reason).slice(0, 200), health: {}, posts: [] };
  const out = {};
  names.forEach((n, i) => { const v = view(n, rs[i]), k = chOf(n).key; if (k) out[k] = v; else Object.assign(out, v); });
  return JSON.stringify(out);
}
