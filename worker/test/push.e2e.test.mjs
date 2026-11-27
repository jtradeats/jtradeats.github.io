// P8.34 stage 3 end to end: the phone routes, the pollers sending pushes, and what is sent. A fake push service (Apple's address) records every request.
// Run: node --test test/push.e2e.test.mjs
// The wire here is FinancialJuice: Walter Bloomberg was retired on 24 Nov, and every FinancialJuice post (marked or not) is an alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'worker-push-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));
const { POSTS_SCHEMA } = await import(pathToFileURL(join(tmp, 'src', 'posts.js')).href);
const push = await import(pathToFileURL(join(tmp, 'src', 'push.js')).href);

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({ bind: (...a) => wrap(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(x => ({ ...x })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; } });
  const o = { prepare: sql => wrap(sql), batch: async st => { const out = []; for (const s of st) out.push(await s.run()); return out; }, db };
  for (const s of POSTS_SCHEMA) db.prepare(s).run();
  return o;
}
const kv = () => { const m = new Map(); return { puts: 0, async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { this.puts++; m.set(k, v); }, m }; };
const addPost = (env, ch, id, t, text, extra = {}) => env.DB.db.prepare('INSERT INTO tg_posts (ch, id, t, j) VALUES (?1, ?2, ?3, ?4)').run(ch, id, t, JSON.stringify({ id, t, text, url: '', media: false, ...extra }));
const EP = 'https://web.push.apple.com/PHONE-TOKEN-1', EP2 = 'https://web.push.apple.com/PHONE-TOKEN-2';

// one fake world: the network answers 404 except the push service, which records and answers with `status[endpoint]` (201 by default)
function world() { return { pushes: [], status: {}, other: 0 }; }
async function run(w, tag, iso, fn) {
  const realNow = Date.now, realFetch = globalThis.fetch;
  Date.now = () => Date.parse(iso);
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (/web\.push\.apple\.com/.test(url)) { w.pushes.push({ url, headers: { ...(o && o.headers) }, method: o && o.method, body: o && o.body }); return new Response(null, { status: w.status[url] || 201 }); }
    w.other++; return new Response('no', { status: 404 });
  };
  try { const { default: worker } = await import(pathToFileURL(ix).href + '?' + tag); return await fn(worker); } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
const req = (path, o = {}) => new Request('https://x.workers.dev' + path, o);
async function call(w, tag, iso, env, path, o) {
  const pending = [];
  return run(w, tag, iso, async worker => { const r = await worker.fetch(req(path, o), env, { waitUntil: p => pending.push(p), passThroughOnException() {} }); const j = await r.json(); await Promise.all(pending); return { status: r.status, j }; });
}
const post = (key, body) => ({ method: 'POST', headers: { 'X-Push-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
async function cron(w, tag, iso, env, expr) {
  const pending = [];
  await run(w, tag, iso, async worker => { await worker.scheduled({ cron: expr, scheduledTime: Date.parse(iso) }, env, { waitUntil: p => pending.push(p) }); await Promise.all(pending); });
}
const FEEDS = '* * * * *', CAL = '*/2 * * * *';
const baseEnv = () => ({ DB: d1(), MARKET_KV: kv(), PUSH_KEY: 'pairing-secret-1' });
async function subscribed(w, env, iso, ep = EP) { await call(w, 's', iso, env, '/push/setup', post('pairing-secret-1')); return call(w, 's', iso, env, '/push/subscribe', post('pairing-secret-1', { endpoint: ep })); }
const NOW = '2026-11-24T14:00:00Z', T = Date.parse(NOW);

test('the routes: POST only, a key must be set in Cloudflare and must match', async () => {
  const w = world();
  assert.equal((await call(w, 'r1', NOW, baseEnv(), '/push/setup')).status, 405);
  const noKey = await call(w, 'r1', NOW, { DB: d1(), MARKET_KV: kv() }, '/push/setup', post('x'));
  assert.equal(noKey.status, 503); assert.match(noKey.j.error, /PUSH_KEY is not set/);
  const bad = await call(w, 'r1', NOW, baseEnv(), '/push/setup', post('wrong'));
  assert.equal(bad.status, 401); assert.equal(bad.j.key, undefined);
  assert.equal((await call(w, 'r1', NOW, baseEnv(), '/push/subscribe', { method: 'POST', body: '{}' })).status, 401, 'no key header at all');
  const pre = await run(w, 'r1', NOW, async worker => worker.fetch(new Request('https://x.workers.dev/push/setup', { method: 'OPTIONS', headers: { Origin: 'https://jtradeats.github.io' } }), baseEnv(), {}));
  assert.equal(pre.status, 204); assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-Push-Key/); assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('setup makes the VAPID key once and returns only the public part', async () => {
  const w = world(), env = baseEnv();
  const a = await call(w, 'r2', NOW, env, '/push/setup', post('pairing-secret-1'));
  assert.equal(a.status, 200); assert.equal(a.j.key.length, 87); assert.equal(env.MARKET_KV.puts, 1);
  const b = await call(w, 'r2b', NOW, env, '/push/setup', post('pairing-secret-1'));
  assert.equal(b.j.key, a.j.key, 'the second call (a fresh isolate too) returns the same key'); assert.equal(env.MARKET_KV.puts, 1, 'and writes nothing');
  assert.ok(!JSON.stringify(a.j).includes('"d"') && !JSON.stringify(a.j).includes('jwk'), 'no private part in the answer');
});

test('subscribe: only a push service address, saved once, removed on unsubscribe', async () => {
  const w = world(), env = baseEnv();
  assert.equal((await call(w, 'r3', NOW, env, '/push/subscribe', post('pairing-secret-1', { endpoint: 'https://evil.example/x' }))).status, 400);
  const a = await subscribed(w, env, NOW); assert.equal(a.j.subs, 1);
  const b = await call(w, 'r3', NOW, env, '/push/subscribe', post('pairing-secret-1', { endpoint: EP })); assert.equal(b.j.subs, 1, 'the same address twice is one subscription');
  const c = await call(w, 'r3', NOW, env, '/push/subscribe', post('pairing-secret-1', { endpoint: EP2 })); assert.equal(c.j.subs, 2);
  const d = await call(w, 'r3', NOW, env, '/push/unsubscribe', post('pairing-secret-1', { endpoint: EP2 })); assert.equal(d.j.subs, 1);
});

test('the poller sends one empty push, signed, for new posts; nothing for old ones; nothing twice', async () => {
  const w = world(), env = baseEnv();
  addPost(env, 'FinancialJuice', 100, T - 5 * 60e3, 'OLD POST BEFORE THE PHONE WAS PAIRED');
  await subscribed(w, env, NOW);
  await cron(w, 'p1', NOW, env, FEEDS);
  assert.equal(w.pushes.length, 0, 'a post from before the subscription is not pushed');
  addPost(env, 'FinancialJuice', 101, T + 20e3, 'FED\'S WILLIAMS: POLICY WELL POSITIONED');
  await cron(w, 'p1', '2026-11-24T14:01:00Z', env, FEEDS);
  assert.equal(w.pushes.length, 1); const p = w.pushes[0];
  assert.equal(p.url, EP); assert.equal(p.method, 'POST'); assert.equal(p.body, undefined, 'empty: no payload to encrypt');
  assert.equal(p.headers.TTL, '600'); assert.equal(p.headers.Urgency, 'high');
  // the signature verifies against the public key the Worker handed out
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(p.headers.Authorization); assert.ok(m);
  const pubKey = (await call(w, 'p1k', NOW, env, '/push/setup', post('pairing-secret-1'))).j.key; assert.equal(m[4], pubKey);
  const pk = await crypto.subtle.importKey('raw', push.unb64u(pubKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, push.unb64u(m[3]), new TextEncoder().encode(m[1] + '.' + m[2])), true);
  assert.equal(JSON.parse(Buffer.from(push.unb64u(m[2]))).aud, 'https://web.push.apple.com');
  await cron(w, 'p1', '2026-11-24T14:02:00Z', env, FEEDS);
  assert.equal(w.pushes.length, 1, 'the same post is not pushed again on the next tick');
  addPost(env, 'FinancialJuice', 102, T + 150e3, 'ANOTHER ONE'); addPost(env, 'FinancialJuice', 103, T + 155e3, 'AND ANOTHER');
  await cron(w, 'p1', '2026-11-24T14:03:00Z', env, FEEDS);
  assert.equal(w.pushes.length, 2, 'two new posts in one tick are one push (the phone lists them itself)');
  const n = await call(w, 'p1a', '2026-11-24T14:03:05Z', env, '/alerts'); assert.ok(n.j.alerts.filter(a => a.kind === 'fj').length >= 3);
});

test('two pollers in the same minute cannot send the same alert twice', async () => {
  const w = world(), env = baseEnv();
  await subscribed(w, env, NOW);
  addPost(env, 'FinancialJuice', 300, T + 10e3, 'OIL JUMPS 2% ON SUPPLY WORRIES', { hot: true });
  await Promise.all([cron(w, 'q1', '2026-11-24T14:01:00Z', env, FEEDS), cron(w, 'q2', '2026-11-24T14:01:00Z', env, FEEDS)]);
  assert.equal(w.pushes.length, 1);
});

test('no phone subscribed: a poller tick builds no alerts and calls nobody', async () => {
  const w = world(), env = baseEnv();
  addPost(env, 'FinancialJuice', 1, T - 5e3, 'x');
  await cron(w, 'n1', NOW, env, FEEDS);
  assert.equal(w.pushes.length, 0);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM alert_sent').get().n, 0, 'nothing is claimed either');
});

test('a phone that has gone (410) is forgotten; a push service error is kept and shown; a good one clears it', async () => {
  const w = world(), env = baseEnv();
  await subscribed(w, env, NOW, EP); await call(w, 'g1', NOW, env, '/push/subscribe', post('pairing-secret-1', { endpoint: EP2 }));
  w.status[EP] = 410; w.status[EP2] = 503;
  addPost(env, 'FinancialJuice', 201, T + 10e3, 'post one');
  await cron(w, 'g1', '2026-11-24T14:01:00Z', env, FEEDS);
  const h = (await call(w, 'g1h', '2026-11-24T14:01:30Z', env, '/health')).j.push;
  assert.equal(h.subs, 1, 'the 410 one is deleted'); assert.equal(h.list[0].host, 'web.push.apple.com'); assert.equal(h.list[0].fails, 1); assert.match(h.list[0].last_err, /HTTP 503/);
  assert.ok(!JSON.stringify(h).includes('PHONE-TOKEN'), '/health never shows the address token');
  assert.equal(h.key_set, true); assert.equal(h.vapid, true);
  w.status[EP2] = 201; addPost(env, 'FinancialJuice', 202, T + 90e3, 'post two');
  await cron(w, 'g1', '2026-11-24T14:02:00Z', env, FEEDS);
  const h2 = (await call(w, 'g1h', '2026-11-24T14:02:30Z', env, '/health')).j.push; assert.equal(h2.list[0].fails, 0); assert.equal(h2.list[0].last_err, null); assert.ok(h2.list[0].last_ok_age_s <= 40);
});

test('the test button: a test alert is listed by /alerts and pushed to every phone, with the notification text', async () => {
  const w = world(), env = baseEnv();
  await subscribed(w, env, NOW);
  const r = await call(w, 't1', '2026-11-24T14:05:00Z', env, '/push/test', post('pairing-secret-1'));
  assert.equal(r.status, 200); assert.equal(r.j.sent, 1); assert.equal(r.j.ok, true); assert.equal(w.pushes.length, 1);
  const a = await call(w, 't1b', '2026-11-24T14:05:03Z', env, '/alerts');
  const t = a.j.alerts.find(x => x.kind === 'test'); assert.ok(t); assert.equal(t.pt, 'Market Dashboard'); assert.match(t.pb, /^Test alert\nPhone alerts are working/);
  await cron(w, 't1', '2026-11-24T14:06:00Z', env, FEEDS); assert.equal(w.pushes.length, 1, 'the poller does not push the test again');
  const late = await call(w, 't1c', '2026-11-24T14:20:00Z', env, '/alerts'); assert.equal(late.j.alerts.filter(x => x.kind === 'test').length, 0, 'gone after 10 minutes');
  push._resetPush();   // the isolate's copy of the key is dropped: a Worker that has never been set up
  const none = await call(w, 't2', NOW, { ...baseEnv() }, '/push/test', post('pairing-secret-1'));
  assert.equal(none.j.ok, false); assert.match(none.j.error || '', /no VAPID key/);
});

test('post text on the phone: headline on the first line, the rest below it, the whole text when the first line is long', async () => {
  const w = world(), env = baseEnv();
  addPost(env, 'FinancialJuice', 401, T - 10e3, 'US TREASURY SECRETARY: NO CHANGE TO AUCTION SIZES\nThe department said on Monday that it would keep the sizes unchanged through the first quarter.');
  addPost(env, 'FinancialJuice', 402, T - 20e3, 'L'.repeat(300));
  const a = (await call(w, 'x1', NOW, env, '/alerts')).j.alerts;
  const x = a.find(i => i.id === 'fj:401'), y = a.find(i => i.id === 'fj:402');
  assert.equal(x.pt, 'News', 'the phone title names no source (see pushtitle.test.mjs)'); assert.equal(x.pb, 'US TREASURY SECRETARY: NO CHANGE TO AUCTION SIZES\nThe department said on Monday that it would keep the sizes unchanged through the first quarter.');
  assert.equal(y.pb, 'L'.repeat(300), 'a long first line is sent whole, not repeated after its own cut headline');
});

test('a reminder 15 minutes before a release: the quiet tick builds the calendar once, pushes, and the next tick does nothing', async () => {
  const w = world(), env = baseEnv();
  const first = (await call(w, 'f0', '2026-11-24T12:00:00Z', { DB: d1() }, '/calendar')).j.events.filter(e => e.imp === 3 && e.src !== 'feed' && e.t > Date.parse('2026-11-24T12:00:00Z'))[0];
  const at = first.t - 15 * 60e3 + 60e3;   // 14 minutes before: inside the 15-minute reminder's window
  const iso = new Date(at).toISOString();
  assert.notEqual(Math.floor(at / 60000) % 10, 0, 'a quiet tick (not a tenth minute)');
  await subscribed(w, env, new Date(at - 3600e3).toISOString());
  const before = w.other;
  await cron(w, 'c1', iso, env, CAL);
  assert.equal(w.pushes.length, 1, 'the reminder is pushed');
  const list = (await call(w, 'c1b', iso, env, '/alerts')).j.alerts.filter(a => a.kind === 'remind');
  assert.equal(list.length, 1); assert.match(list[0].pt, /^High impact · release in 1[45] min$/); assert.equal(list[0].pb.split('\n')[0], first.title);
  await cron(w, 'c1', new Date(at + 120e3).toISOString(), env, CAL);
  assert.equal(w.pushes.length, 1, 'already sent: not again');
  const quiet = await call(w, 'c1c', '2026-11-24T05:03:00Z', env, '/health'); assert.equal(quiet.status, 200);
});
