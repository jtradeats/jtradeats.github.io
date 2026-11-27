// A poll whose page has the same newest post id as the last full parse (and that parse is under FEED_FULL old) is answered without the HTMLRewriter.
// Uses a fake runner that drives the real attachParser handlers from simple markup. Run: node --test test/feed.skip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/feed.js';

let clock = 1_800_000_000_000; const realNow = Date.now;
let runnerCalls = 0, pageHtml = '', failNext = false;
F._useRunner(async (html, attach) => {
  runnerCalls++;
  const H = {}; attach({ on(sel, h) { H[sel] = h; return this; } });
  const el = attrs => ({ getAttribute: k => attrs[k] ?? null, onEndTag() {} });
  for (const blk of html.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const id = /data-post="([^"]+)"/.exec(blk)[1], t = /datetime="([^"]+)"/.exec(blk)[1], txt = /<text>([\s\S]*?)<\/text>/.exec(blk)[1];
    H['[data-post]'].element(el({ 'data-post': id }));
    H['.tgme_widget_message_text'].element(el({})); H['.tgme_widget_message_text'].text({ text: txt });
    H['.tgme_widget_message_date time'].element(el({ datetime: t }));
  }
});
const realFetch = globalThis.fetch;
const ch = 'FinancialJuice', env = {}, ctx = { waitUntil() {} };
const post = (id, text, views) => `<div class="tgme_widget_message_wrap"><div data-post="${ch}/${id}"><text>${text}</text><span>${views}K</span><time datetime="${new Date(1_799_990_000_000 + id * 1000).toISOString()}"></time></div></div>`;
const page = (ids, views = 1, edits = {}) => '<html>' + ids.map(i => post(i, edits[i] || `headline ${i}`, views)).join('') + '</html>';
const poll = async (adv = 12000) => { clock += adv; return JSON.parse(await F.getFeed(env, ctx, { channel: ch, debug: true })); };

test('the skip logic', async t => {
  Date.now = () => clock;
  globalThis.fetch = async () => failNext ? (failNext = false, new Response('x', { status: 503 })) : new Response(pageHtml, { status: 200 });
  try {
    assert.equal(F.newestId(page([5, 9, 7]), ch), 9);
    assert.equal(F.newestId('<html></html>', ch), null);
    pageHtml = page([101, 102, 103]);
    let v = await poll(); assert.equal(runnerCalls, 1); assert.equal(v.posts.length, 3);
    pageHtml = page([101, 102, 103], 7); v = await poll();
    assert.equal(runnerCalls, 1); assert.equal(v.skips, 1); assert.equal(v.status, 'ok'); assert.equal(v.health.parsed, 3);
    pageHtml = page([101, 102, 103, 104], 7); v = await poll();
    assert.equal(runnerCalls, 2); assert.equal(v.posts[0].id, 104);
    pageHtml = page([101, 102, 103, 104], 7, { 102: 'EDITED' }); v = await poll();
    assert.equal(v.posts.find(p => p.id === 102).text, 'headline 102');            // within the minute: not yet (the trade-off)
    for (let i = 0; i < 4; i++) v = await poll();
    assert.equal(v.posts.find(p => p.id === 102).text, 'EDITED');                  // a full parse after FEED_FULL
    failNext = true; v = await poll(); assert.equal(v.status, 'broken');
    v = await poll(16000); assert.equal(v.status, 'ok'); assert.equal(v.posts.length, 4);
  } finally { Date.now = realNow; globalThis.fetch = realFetch; F._useRunner(null); }
});
test('cleanText is unchanged by the hoisted patterns', () => {
  assert.equal(F.cleanText('*Headline text |FJ', 'FinancialJuice'), 'Headline text');
  assert.equal(F.cleanText('Line one\n(@FinancialJuice)', 'FinancialJuice'), 'Line one');
  assert.equal(F.cleanText('Hello (@WalterBloomberg)', 'WalterBloomberg'), 'Hello');
});
