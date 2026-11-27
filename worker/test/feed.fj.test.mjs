// FinancialJuice mirror: the red exclamation mark -> hot, the "|FJ" tail, per-channel state. Run: node --test worker/test/feed.fj.test.mjs
// needs: npm i -D html-rewriter-wasm
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTMLRewriter } from 'html-rewriter-wasm';
import { parseTelegram, cleanText, splitHot, mergePosts, getFeed, feedHealth, CHANNELS, FEED_CHANNEL, _useRunner, _state, _stateOf } from '../src/feed.js';

const run = async (html, attach) => {
  const rw = new HTMLRewriter(() => {});
  attach(rw);
  await rw.write(new TextEncoder().encode(html));
  await rw.end();
  rw.free();
};
_useRunner(run);

const MARK = `<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/E29D97.png')"><b>❗</b></i>`;
const MARK_NO_GLYPH = `<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/E29D97.png')"><b></b></i>`;
const OTHER_EMOJI = `<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/F09F94B4.png')"><b>\u{1F534}</b></i>`;
const msg = (ch, id, inner, time = '2026-11-15T15:00:05+00:00', extra = '') =>
  `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${ch}/${id}">` +
  `<div class="tgme_widget_message_bubble">${extra}<div class="tgme_widget_message_text js-message_text" dir="auto">${inner}</div>` +
  `<div class="tgme_widget_message_footer"><div class="tgme_widget_message_info"><span class="tgme_widget_message_meta">` +
  `<a class="tgme_widget_message_date" href="https://t.me/${ch}/${id}"><time datetime="${time}" class="time">10:00</time></a></span></div></div></div></div></div>`;
const FJ = 'FinancialJuice';
const TAIL = `|<a href="https://www.financialjuice.com/home">FJ</a>`;
const page = (...m) => `<html><body><section class="tgme_channel_history js-message_history">${m.join('\n')}</section></body></html>`;

test('a post that starts with the red mark is hot, and the mark and the |FJ tail leave the text', async () => {
  const html = page(
    msg(FJ, 144640, `${MARK} US JOLTS JOB OPENINGS ACTUAL 7.523M (FORECAST 7.164M, PREVIOUS 7.079M) <a href="?q=%24MACRO">$MACRO</a>${TAIL}`),
    msg(FJ, 144639, `US Factory Orders September Report${TAIL}`),
  );
  const posts = await parseTelegram(html, run, FJ);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(p => p.id), [144640, 144639]);
  assert.equal(posts[0].hot, true);
  assert.equal(posts[0].text, 'US JOLTS JOB OPENINGS ACTUAL 7.523M (FORECAST 7.164M, PREVIOUS 7.079M) $MACRO');
  assert.equal(posts[0].url, 'https://t.me/FinancialJuice/144640');
  assert.equal(posts[1].text, 'US Factory Orders September Report');
  assert.ok(!('hot' in posts[1]), 'plain posts carry no hot key');
});

test('the mark is found as a plain character, with the variation selector, and as an emoji image without a glyph', async () => {
  const html = page(
    msg(FJ, 5, `❗ US FACTORY ORDERS MOM ACTUAL 1.8%${TAIL}`),
    msg(FJ, 4, `❗️ VARIATION SELECTOR${TAIL}`),
    msg(FJ, 3, `${MARK_NO_GLYPH} IMAGE ONLY${TAIL}`),
  );
  const [a, b, c] = await parseTelegram(html, run, FJ);
  assert.equal(a.hot, true); assert.equal(a.text, 'US FACTORY ORDERS MOM ACTUAL 1.8%');
  assert.equal(b.hot, true); assert.equal(b.text, 'VARIATION SELECTOR');
  assert.equal(c.hot, true); assert.equal(c.text, 'IMAGE ONLY');
});

const BANG = `<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/E280BCEFB88F.png')"><b>\u203C\uFE0F</b></i>`;
const BANG_NO_GLYPH = `<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/E280BCEFB88F.png')"><b></b></i>`;

test('the double mark (U+203C) is hot too: bang flag, "BREAKING:" label removed and flagged, with or without the variation selector', async () => {
  const html = page(
    msg(FJ, 9, `${BANG} BREAKING: CANADIAN CPI YOY ACTUAL 3.1% (FORECAST 3.2%, PREVIOUS 3.1%) <a href="?q=%24MACRO">$MACRO</a>${TAIL}`),
    msg(FJ, 8, `\u203C NONFARM PAYROLLS ACTUAL 150K${TAIL}`),
    msg(FJ, 7, `\u203C\uFE0F BREAKING US CPI MOM ACTUAL 0.3%${TAIL}`),
    msg(FJ, 6, `\u2757 SINGLE MARK${TAIL}`),
  );
  const [a, b, c, d] = await parseTelegram(html, run, FJ);
  assert.equal(a.hot, true); assert.equal(a.bang, true); assert.equal(a.breaking, true);
  assert.equal(a.text, 'CANADIAN CPI YOY ACTUAL 3.1% (FORECAST 3.2%, PREVIOUS 3.1%) $MACRO');
  assert.equal(b.hot, true); assert.equal(b.bang, true); assert.ok(!('breaking' in b), 'no label, no breaking key');
  assert.equal(b.text, 'NONFARM PAYROLLS ACTUAL 150K');
  assert.equal(c.hot, true); assert.equal(c.breaking, true); assert.equal(c.text, 'US CPI MOM ACTUAL 0.3%');
  assert.equal(d.hot, true); assert.ok(!('bang' in d) && !('breaking' in d), 'the single mark is unchanged');
  assert.equal(d.text, 'SINGLE MARK');
});

test('the double mark as an emoji image only (glyph missing) is found by its E280BC file name', async () => {
  const html = page(msg(FJ, 3, `${BANG_NO_GLYPH} BREAKING: IMAGE ONLY${TAIL}`), msg(FJ, 2, `${MARK_NO_GLYPH} SINGLE IMAGE${TAIL}`));
  const [a, b] = await parseTelegram(html, run, FJ);
  assert.equal(a.hot, true); assert.equal(a.bang, true); assert.equal(a.breaking, true); assert.equal(a.text, 'IMAGE ONLY');
  assert.equal(b.hot, true); assert.ok(!('bang' in b)); assert.equal(b.text, 'SINGLE IMAGE');
});

test('a double mark in the middle of the text is not hot, and "BREAKING" without the mark is not hot', async () => {
  const html = page(msg(FJ, 2, `US DURABLE GOODS \u203C REVISED${TAIL}`), msg(FJ, 1, `BREAKING: NO MARK${TAIL}`));
  const posts = await parseTelegram(html, run, FJ);
  assert.equal(posts.filter(p => p.hot).length, 0);
  assert.ok(posts[1].text.startsWith('BREAKING:'));
});

test('DeItaone: a leading double mark stays text (the double mark is a FinancialJuice marker only)', async () => {
  const posts = await parseTelegram(page(msg('WalterBloomberg', 7, `\u203C HEADLINE (@WalterBloomberg)`)), run);
  assert.equal(posts[0].text, '\u203C HEADLINE');
  assert.deepEqual(Object.keys(posts[0]).sort(), ['id', 'media', 't', 'text', 'url']);
});

test('splitHot: the double mark, with the label, with an image only', () => {
  assert.deepEqual(splitHot('\u203C BREAKING: A'), { text: 'A', hot: true, bang: true, breaking: true });
  assert.deepEqual(splitHot('\u203C\uFE0F A'), { text: 'A', hot: true, bang: true });
  assert.deepEqual(splitHot('BREAKING: A', 'bang'), { text: 'A', hot: true, bang: true, breaking: true });
  assert.deepEqual(splitHot('A \u203C'), { text: 'A \u203C', hot: false });
});

test('getFeed carries bang and breaking to the page, and the hot count includes double-mark posts', async () => {
  const m = await fresh();
  const f = mockFetch({ [`https://t.me/s/${FJ}`]: page(msg(FJ, 3, `\u203C BREAKING: X${TAIL}`), msg(FJ, 2, `\u2757 Y${TAIL}`), msg(FJ, 1, `Z${TAIL}`)),
    'https://t.me/s/WalterBloomberg': page(msg('WalterBloomberg', 1, 'q')) });
  try {
    const fj = JSON.parse(await m.getFeed(null, null, { channel: FJ }));
    assert.deepEqual(fj.posts.map(p => [p.id, !!p.hot, !!p.bang, !!p.breaking]), [[3, true, true, true], [2, true, false, false], [1, false, false, false]]);
    assert.equal(fj.health.hot, 2);
  } finally { f.restore(); }
});

test('only a mark at the start counts: not mid-text, not another emoji', async () => {
  const html = page(
    msg(FJ, 3, `US CORE DURABLE GOODS ${MARK} REVISED${TAIL}`),
    msg(FJ, 2, `${OTHER_EMOJI} RED CIRCLE IS NOT THE MARK${TAIL}`),
    msg(FJ, 1, `Iran: No new development${TAIL}`),
  );
  const posts = await parseTelegram(html, run, FJ);
  assert.equal(posts.filter(p => p.hot).length, 0);
  assert.ok(posts[0].text.includes('❗'), 'a mid-text mark stays in the text');
});

test('a quoted reply, even with another channel\'s data-post, does not leak into a post or become a post', async () => {
  // a reply quote can carry the data-post of another message (and the same text class as the post itself)
  const reply = `<a class="tgme_widget_message_reply" data-post="SomeoneElse/21" href="https://t.me/SomeoneElse/21"><div class="tgme_widget_message_text js-message_text">\u2757 QUOTED, NOT THE POST</div></a>`;
  const html = page(msg(FJ, 20, `Plain post${TAIL}`, undefined, reply));
  const posts = await parseTelegram(html, run, FJ);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'Plain post');
  assert.ok(!posts[0].hot);
});

test('DeItaone output is unchanged: default channel, no hot key, a leading mark stays text', async () => {
  const html = page(msg('WalterBloomberg', 7, `*\u2757 HEADLINE (@WalterBloomberg)`));
  const posts = await parseTelegram(html, run);   // old call shape
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0]).sort(), ['id', 'media', 't', 'text', 'url']);
  assert.equal(posts[0].text, '❗ HEADLINE');
  assert.equal(cleanText('x |FJ'), 'x |FJ', 'the |FJ tail is stripped on FinancialJuice only');
  assert.equal(cleanText('x |FJ', FJ), 'x');
  assert.equal(FEED_CHANNEL, 'WalterBloomberg');
  assert.equal(_state, _stateOf('WalterBloomberg'));
});

test('splitHot and mergePosts', () => {
  assert.deepEqual(splitHot('❗ A'), { text: 'A', hot: true });
  assert.deepEqual(splitHot('A ❗'), { text: 'A ❗', hot: false });
  assert.deepEqual(splitHot('A', true), { text: 'A', hot: true });
  const m = mergePosts([{ id: 1, text: 'a' }], [{ id: 1, text: 'a', hot: true }, { id: 2, text: 'b' }]);
  assert.equal(m.added, 1);
  assert.equal(m.posts.find(p => p.id === 1).hot, true, 'a re-read post replaces the old copy');
});

test('getFeed: the FinancialJuice window, hot count, channel in the answer, KV key and write gap; Walter Bloomberg (retired 24 Nov) is no channel', async () => {
  const writes = [];
  const env = { MARKET_KV: { get: async () => null, put: async (k, v) => { writes.push(k); } } };
  const bodies = {
    [`https://t.me/s/${FJ}`]: page(msg(FJ, 11, `${MARK} HOT${TAIL}`), msg(FJ, 10, `quiet${TAIL}`)),
  };
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => { urls.push(String(u)); return new Response(bodies[String(u)] || '', { status: bodies[String(u)] ? 200 : 404 }); };
  try {
    const fj = JSON.parse(await getFeed(env, null, { channel: FJ }));
    assert.equal(fj.channel, FJ);
    assert.equal(fj.status, 'ok');
    assert.equal(fj.health.hot, 1);
    assert.deepEqual(fj.posts.map(p => [p.id, !!p.hot]), [[11, true], [10, false]]);
    assert.deepEqual(writes, ['feed:window:FinancialJuice']);
    assert.ok(!('gap' in fj), 'no gap flag when the window is contiguous or empty');

    assert.equal(feedHealth(Date.now(), FJ).hot, 1);
    assert.deepEqual(urls, [`https://t.me/s/${FJ}`], 'one channel, one request: Walter Bloomberg is never asked for');
    assert.deepEqual(Object.keys(CHANNELS), ['FinancialJuice'], 'the route refuses any channel that is not listed here (?ch=WalterBloomberg is a 400)');
  } finally { globalThis.fetch = realFetch; }
});

// ---- the combined call (plan P1): a fresh module instance per test, because each channel's poll is cached for 10 s ----
let n = 0;
const fresh = async () => { const m = await import(`../src/feed.js?case=${++n}`); m._useRunner(run); return m; };
const mockFetch = bodies => { const urls = []; const real = globalThis.fetch;
  globalThis.fetch = async u => { urls.push(String(u)); const b = bodies[String(u)]; return b === undefined ? new Response('', { status: 429 }) : new Response(b, { status: 200 }); };
  return { urls, restore: () => { globalThis.fetch = real; } }; };

test('getFeeds: FinancialJuice under fj and nothing at the top level (the Walter Bloomberg view went on 24 Nov); one request, no stagger needed', async () => {
  const m = await fresh();
  const f = mockFetch({
    [`https://t.me/s/${FJ}`]: page(msg(FJ, 11, `${MARK} HOT${TAIL}`), msg(FJ, 10, `quiet${TAIL}`)),
  });
  try {
    const all = JSON.parse(await m.getFeeds(null, null));
    assert.deepEqual(f.urls, [`https://t.me/s/${FJ}`]);
    assert.deepEqual(Object.keys(all), ['fj'], 'no top-level channel, status or posts any more');
    assert.equal(all.fj.channel, FJ);
    assert.deepEqual(all.fj.posts.map(p => [p.id, !!p.hot]), [[11, true], [10, false]]);
    assert.equal(all.fj.health.hot, 1);
    assert.equal(m.feedHealth(Date.now(), FJ).hot, 1);
  } finally { f.restore(); }
});

test('getFeeds: a channel that fails says broken in its own block, with the reason, and the call still answers', async () => {
  const m = await fresh();
  const f = mockFetch({});   // Telegram answers 429 for the channel
  try {
    const all = JSON.parse(await m.getFeeds(null, null));
    assert.equal(all.fj.status, 'broken');
    assert.match(all.fj.error, /429/);
    assert.deepEqual(all.fj.posts, []);
  } finally { f.restore(); }
});

test('a window that does not meet the new page is flagged: older posts may be missing', async () => {
  const m = await fresh();
  const env = { MARKET_KV: { get: async () => ({ at: 1, posts: [{ id: 100, t: 1, text: 'old', url: 'u', media: false }] }), put: async () => {} } };
  const f = mockFetch({ [`https://t.me/s/${FJ}`]: page(msg(FJ, 140, 'new a'), msg(FJ, 139, 'new b')) });
  try {
    const fj = JSON.parse(await m.getFeed(env, null, { channel: FJ }));
    assert.equal(fj.gap, true);
    assert.deepEqual(fj.posts.map(p => p.id), [140, 139, 100]);
  } finally { f.restore(); }
});

test('the FinancialJuice snapshot is written to KV at most every 15 minutes (96 writes a day, D79)', () => {
  assert.equal(CHANNELS.FinancialJuice.kvGap, 15 * 60000);
  assert.equal(CHANNELS.FinancialJuice.kv, 'feed:window:FinancialJuice');
});
