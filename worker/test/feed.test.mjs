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

test('getFeed: per-channel window, hot count, channel in the answer, KV key and write gap per channel', async () => {
  const writes = [];
  const env = { MARKET_KV: { get: async () => null, put: async (k, v) => { writes.push(k); } } };
  const bodies = {
    [`https://t.me/s/${FJ}`]: page(msg(FJ, 11, `${MARK} HOT${TAIL}`), msg(FJ, 10, `quiet${TAIL}`)),
    'https://t.me/s/WalterBloomberg': page(msg('WalterBloomberg', 99, 'dm post')),
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

    const dm = JSON.parse(await getFeed(env, null, {}));
    assert.equal(dm.channel, 'WalterBloomberg');
    assert.deepEqual(dm.posts.map(p => p.id), [99]);
    assert.ok(!('hot' in dm.health));
    assert.deepEqual(writes, ['feed:window:FinancialJuice', 'feed:window']);

    assert.equal(feedHealth(Date.now(), FJ).hot, 1);
    assert.equal(feedHealth().window, 1, 'the default channel keeps its own window');
    assert.deepEqual(urls, [`https://t.me/s/${FJ}`, 'https://t.me/s/WalterBloomberg']);
    assert.deepEqual(Object.keys(CHANNELS), ['WalterBloomberg', 'FinancialJuice']);
  } finally { globalThis.fetch = realFetch; }
});

// ---- the combined call (plan P1): a fresh module instance per test, because each channel's poll is cached for 10 s ----
let n = 0;
const fresh = async () => { const m = await import(`../src/feed.js?case=${++n}`); m._useRunner(run); return m; };
const mockFetch = bodies => { const urls = []; const real = globalThis.fetch;
  globalThis.fetch = async u => { urls.push(String(u)); const b = bodies[String(u)]; return b === undefined ? new Response('', { status: 429 }) : new Response(b, { status: 200 }); };
  return { urls, restore: () => { globalThis.fetch = real; } }; };

test('getFeeds: DeItaone at the top level as before, FinancialJuice under fj; the two polls are staggered', async () => {
  const m = await fresh();
  const f = mockFetch({
    'https://t.me/s/WalterBloomberg': page(msg('WalterBloomberg', 99, 'dm post')),
    [`https://t.me/s/${FJ}`]: page(msg(FJ, 11, `${MARK} HOT${TAIL}`), msg(FJ, 10, `quiet${TAIL}`)),
  });
  try {
    const t0 = Date.now();
    const all = JSON.parse(await m.getFeeds(null, null));
    assert.ok(Date.now() - t0 >= 300, 'the second channel waits a moment');
    assert.deepEqual(f.urls, ['https://t.me/s/WalterBloomberg', `https://t.me/s/${FJ}`]);
    assert.equal(all.channel, 'WalterBloomberg');
    assert.deepEqual(all.posts.map(p => p.id), [99]);
    assert.equal(all.fj.channel, FJ);
    assert.deepEqual(all.fj.posts.map(p => [p.id, !!p.hot]), [[11, true], [10, false]]);
    assert.equal(all.fj.health.hot, 1);
    assert.equal(m.feedHealth(Date.now(), FJ).hot, 1);
  } finally { f.restore(); }
});

test('getFeeds: one channel failing leaves the other intact, and its block says broken', async () => {
  const m = await fresh();
  const f = mockFetch({ [`https://t.me/s/${FJ}`]: page(msg(FJ, 5, `❗ A${TAIL}`)) });   // DeItaone answers 429
  try {
    const all = JSON.parse(await m.getFeeds(null, null));
    assert.equal(all.status, 'broken');
    assert.match(all.error, /429/);
    assert.equal(all.fj.status, 'ok');
    assert.equal(all.fj.posts.length, 1);
  } finally { f.restore(); }
});

test('a window that does not meet the new page is flagged: older posts may be missing', async () => {
  const m = await fresh();
  const env = { MARKET_KV: { get: async () => ({ at: 1, posts: [{ id: 100, t: 1, text: 'old', url: 'u', media: false }] }), put: async () => {} } };
  const f = mockFetch({ [`https://t.me/s/${FJ}`]: page(msg(FJ, 140, 'new a'), msg(FJ, 139, 'new b')), 'https://t.me/s/WalterBloomberg': page(msg('WalterBloomberg', 1, 'x')) });
  try {
    const fj = JSON.parse(await m.getFeed(env, null, { channel: FJ }));
    assert.equal(fj.gap, true);
    assert.deepEqual(fj.posts.map(p => p.id), [140, 139, 100]);
    const dm = JSON.parse(await m.getFeed(env, null, {}));
    assert.ok(!('gap' in dm), 'no gap flag when the window is contiguous or empty');
  } finally { f.restore(); }
});

test('the FinancialJuice snapshot uses the same 15 minute throttle as DeItaone', () => {
  assert.equal(CHANNELS.FinancialJuice.kvGap, CHANNELS.WalterBloomberg.kvGap);
  assert.equal(CHANNELS.FinancialJuice.kvGap, 15 * 60000);
});
