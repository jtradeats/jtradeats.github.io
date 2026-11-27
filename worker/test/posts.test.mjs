// Telegram posts in D1 (plan P8.31) and the gap fill. Run: node --test test/posts.test.mjs
// The D1 stand-in is a real SQLite database (node:sqlite), so the SQL itself is tested, not a guess at it. Needs: npm i -D html-rewriter-wasm
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { HTMLRewriter } from 'html-rewriter-wasm';
import { savePosts, loadPosts, prunePosts, postsSummary, beat, beats, ensurePosts, _resetPosts } from '../src/posts.js';
import * as F from '../src/feed.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(x => ({ ...x })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
  });
  return { db, prepare: sql => wrap(sql), batch: async stmts => { for (const s of stmts) await s.run(); return []; } };
}
const post = (id, text = 't' + id, extra = {}) => ({ id, t: 1e12 + id * 1000, text, url: 'https://t.me/FinancialJuice/' + id, media: false, ...extra });

test('save, load newest first, and an unchanged re-read writes nothing', async () => {
  _resetPosts(); const env = { DB: d1() };
  assert.equal(await savePosts(env, 'FJ', [post(1), post(2), post(3, 'c', { hot: true })]), 3);
  const rows = await loadPosts(env, 'FJ', 10);
  assert.deepEqual(rows.map(p => p.id), [3, 2, 1]); assert.equal(rows[0].hot, true);
  const before = env.DB.db.prepare('SELECT total_changes() AS n').get().n;
  await savePosts(env, 'FJ', [post(1), post(2)]);                       // the same content again
  assert.equal(env.DB.db.prepare('SELECT total_changes() AS n').get().n, before, 'no row was rewritten');
  await savePosts(env, 'FJ', [post(2, 'edited')]);                      // an edit does rewrite
  assert.equal((await loadPosts(env, 'FJ', 10)).find(p => p.id === 2).text, 'edited');
  assert.deepEqual((await loadPosts(env, 'DM', 10)), [], 'channels are separate');
});

test('prune keeps the newest rows of one channel only; summary and heartbeats', async () => {
  _resetPosts(); const env = { DB: d1() };
  await savePosts(env, 'FJ', Array.from({ length: 30 }, (_, i) => post(i + 1)));
  await savePosts(env, 'DM', [post(5), post(6)]);
  await prunePosts(env, 'FJ', 10);
  assert.deepEqual((await loadPosts(env, 'FJ', 100)).map(p => p.id), [30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);   // keeps rows above the 10th newest: 11 incl. the boundary
  assert.equal((await loadPosts(env, 'DM', 100)).length, 2);
  const sum = await postsSummary(env); assert.equal(sum.FJ.newest_id, 30); assert.equal(sum.DM.rows, 2);
  await beat(env, 'feeds', 111); await beat(env, 'feeds', 222); await beat(env, 'cal', 5);
  assert.deepEqual(await beats(env), { feeds: 222, cal: 5 });
});

test('no D1, or a broken D1, never throws', async () => {
  _resetPosts();
  assert.equal(await savePosts({}, 'FJ', [post(1)]), 0); assert.equal(await loadPosts({}, 'FJ', 5), null); assert.equal(await prunePosts(null, 'FJ'), false);
  assert.equal(await postsSummary({}), null); assert.equal(await beat({}, 'x', 1), false); assert.equal(await beats({}), null);
  _resetPosts();
  const bad = { DB: { prepare: () => ({ run: async () => { throw new Error('d1 down'); }, bind() { return this; }, all: async () => { throw new Error('d1 down'); } }) } };
  assert.equal(await savePosts(bad, 'FJ', [post(1)]), 0); assert.equal(await loadPosts(bad, 'FJ', 5), null);
});

// ---- through the feed: storage, cold-start seeding and gap filling ----
const run = async (html, attach) => { const rw = new HTMLRewriter(() => {}); attach(rw); await rw.write(new TextEncoder().encode(html)); await rw.end(); rw.free(); };
F._useRunner(run);
const FJ = 'FinancialJuice';
const msg = (id, text) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${FJ}/${id}"><div class="tgme_widget_message_bubble"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><div class="tgme_widget_message_footer"><div class="tgme_widget_message_info"><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${FJ}/${id}"><time datetime="2026-11-19T00:${String(id % 60).padStart(2, '0')}:00+00:00" class="time">x</time></a></span></div></div></div></div></div>`;
const page = ids => `<html><body><section class="tgme_channel_history js-message_history">${ids.map(i => msg(i, 'post ' + i)).join('\n')}</section></body></html>`;

test('a cold isolate seeds its window from D1, polls, stores only the new posts, and closes a hole with older pages', async () => {
  _resetPosts();
  const env = { DB: d1() };
  await savePosts(env, FJ, [100, 101, 102].map(i => post(i, 'post ' + i)));   // what an earlier run stored
  const st = F._stateOf(FJ); Object.assign(st, { posts: [], seeded: false, at: 0, okAt: 0, failAt: 0, fullAt: 0, saved: 0, filled: 0, gapId: 0 });
  const realFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async u => {
    u = String(u); calls.push(u);
    if (u.endsWith('?before=121')) return new Response(page([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120]), { status: 200 });
    if (u.endsWith(`/s/${FJ}`)) return new Response(page(Array.from({ length: 20 }, (_, i) => 121 + i)), { status: 200 });   // 121..140: ids 103..120 were missed
    return new Response('no', { status: 404 });
  };
  try {
    const v = JSON.parse(await F.getFeed(env, null, { channel: FJ, debug: true }));
    assert.equal(v.status, 'ok'); assert.equal(v.fromDb, true);
    assert.equal(v.posts[0].id, 140); assert.equal(v.posts.at(-1).id, 100);
    assert.ok(calls.some(u => u.endsWith('?before=121')), 'older page read');
    assert.equal(v.gap, undefined, 'the hole is closed, so the page is not told there is one');
    assert.equal(v.posts.length, 41);   // 100..140
    const stored = await loadPosts(env, FJ, 200);
    assert.equal(stored.length, 41); assert.equal(v.saved, 38);   // 103..140: the three already held were not rewritten
  } finally { globalThis.fetch = realFetch; }
});

test('a hole too big for the pages allowed is reported, not hidden', async () => {
  _resetPosts();
  const env = { DB: d1() };
  await savePosts(env, FJ, [post(10)]);
  const st = F._stateOf(FJ); Object.assign(st, { posts: [], seeded: false, at: 0, okAt: 0, failAt: 0, fullAt: 0, saved: 0, filled: 0, gapId: 0 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async u => {
    u = String(u); const m = /before=(\d+)/.exec(u), top = m ? +m[1] : 1000;
    return new Response(page(Array.from({ length: 20 }, (_, i) => top - 1 - i)), { status: 200 });
  };
  try {
    const v = JSON.parse(await F.getFeed(env, null, { channel: FJ }));
    assert.equal(v.gap, true);   // 1000..981, then two older pages of 20: still far above id 10
    assert.equal(v.posts.length, 61);   // the seeded post 10 and three pages of 20
  } finally { globalThis.fetch = realFetch; }
});
