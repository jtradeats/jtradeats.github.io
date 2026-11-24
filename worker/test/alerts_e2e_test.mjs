// P8.34 stage 1 end to end: GET /alerts through the Worker, with posts in D1 and the calendar built from the schedule file.
// Run: node --test test/alerts.e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'worker-alerts-'));
cpSync(new URL('../src', import.meta.url), join(tmp, 'src'), { recursive: true });
cpSync(new URL('../config', import.meta.url), join(tmp, 'config'), { recursive: true });
const ix = join(tmp, 'src', 'index.js');
writeFileSync(ix, readFileSync(ix, 'utf8').replace(/(import [^;\n]+ from '\.\.\/config\/[^']+\.json')/g, "$1 with { type: 'json' }"));
const { POSTS_SCHEMA } = await import(pathToFileURL(join(tmp, 'src', 'posts.js')).href);

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql, args = []) => ({ bind: (...a) => wrap(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(x => ({ ...x })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; } });
  const o = { prepare: sql => wrap(sql), batch: async st => { for (const s of st) await s.run(); return []; }, db };
  for (const s of POSTS_SCHEMA) db.prepare(s).run();
  return o;
}
const addPost = (env, ch, id, t, text, extra = {}) => env.DB.db.prepare('INSERT INTO tg_posts (ch, id, t, j) VALUES (?1, ?2, ?3, ?4)').run(ch, id, t, JSON.stringify({ id, t, text, url: '', media: false, ...extra }));
const noNet = async () => new Response('no', { status: 404 });

async function call(tag, iso, path, env) {
  const realNow = Date.now, realFetch = globalThis.fetch, pending = [];
  Date.now = () => Date.parse(iso); globalThis.fetch = noNet;
  try {
    const { default: worker } = await import(pathToFileURL(ix).href + '?' + tag);
    const r = await worker.fetch(new Request('https://x.workers.dev' + path), env, { waitUntil: p => pending.push(p), passThroughOnException() {} });
    const j = await r.json(); await Promise.all(pending); return { status: r.status, j };
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
}
// the first high-impact scheduled release after 24 Nov 2026 12:00 UTC (found through the Worker itself, so the test follows the schedule file)
const base = '2026-11-24T12:00:00Z';
const first = (await call('find', base, '/calendar', { DB: d1() })).j.events.filter(e => e.imp === 3 && e.src !== 'feed' && e.t > Date.parse(base))[0];
const iso = ms => new Date(ms).toISOString();

test('FinancialJuice posts from D1 (marked or not) become alerts, Walter Bloomberg posts no longer do; the since filter and the ids work', async () => {
  const env = { DB: d1() }, now = Date.parse('2026-11-24T14:00:00Z');
  addPost(env, 'WalterBloomberg', 501, now - 20e3, 'FED\'S GOOLSBEE: DISINFLATION PROGRESS SLOWED\nmore text');
  addPost(env, 'WalterBloomberg', 500, now - 3600e3, 'an hour old');
  addPost(env, 'FinancialJuice', 900, now - 40e3, 'OIL JUMPS 2% ON SUPPLY WORRIES', { hot: true });
  addPost(env, 'FinancialJuice', 901, now - 10e3, 'OIL JUMPS 2% ON SUPPLY WORRIES (UPDATE)', { hot: true });
  addPost(env, 'FinancialJuice', 902, now - 30e3, 'US 10-YEAR AUCTION DRAWS STRONG DEMAND', {});   // no red mark: it alerts too (24 Nov)
  const r = await call('a1', iso(now), '/alerts', env);
  assert.equal(r.status, 200); assert.deepEqual(r.j.errors, []);
  const ids = r.j.alerts.map(a => a.id).filter(i => /^(dm|fj):/.test(i));
  assert.deepEqual(ids.sort(), ['fj:900', 'fj:902'], 'two FinancialJuice stories (an id is the first post of its story); the Walter post in D1 is no longer read (retired 24 Nov)');
  const fj = r.j.alerts.find(a => a.id === 'fj:900'); assert.equal(fj.n, 2); assert.equal(fj.src, 'FinancialJuice');
  const plain = r.j.alerts.find(a => a.id === 'fj:902'); assert.equal(plain.h, 'US 10-YEAR AUCTION DRAWS STRONG DEMAND'); assert.equal(plain.n, 1); assert.equal(plain.nt, 'FinancialJuice');
  // 10 seconds later, asking only for what is newer than the last alert seen
  const r2 = await call('a1', iso(now + 10e3), '/alerts?since=' + (now - 15e3), env);
  assert.deepEqual(r2.j.alerts.map(a => a.id).filter(i => /^(dm|fj):/.test(i)), [], 'nothing new since the newest alert the client has: both FinancialJuice stories began before that moment');
  addPost(env, 'FinancialJuice', 903, now + 5e3, 'NEW HEADLINE');
  const r3 = await call('a1', iso(now + 20e3), '/alerts?since=' + (now - 15e3), env);
  assert.deepEqual(r3.j.alerts.map(a => a.id).filter(i => /^(dm|fj):/.test(i)), ['fj:903']);
});

test('a high-impact release: reminders at 15 and 5 minutes and at the release, each once per moment, gone when too late', async () => {
  assert.ok(first, 'the schedule file has an upcoming high-impact release');
  const env = { DB: d1() }, t = first.t;
  const at = async (tag, ms) => (await call(tag, iso(ms), '/alerts', env)).j.alerts.filter(a => a.kind === 'remind');
  const a15 = await at('b1', t - 15 * 60e3 + 30e3);
  assert.equal(a15.length, 1); assert.equal(a15[0].id, 'rem|' + t + '|15'); assert.match(a15[0].tag, /RELEASE IN 15 MIN|RELEASE IN 14 MIN/); assert.equal(a15[0].src, 'Calendar · USD');
  const again = await at('b1', t - 15 * 60e3 + 50e3);
  assert.equal(again[0].id, a15[0].id, 'the same id on every call, so a client shows it once');
  const a5 = await at('b1', t - 5 * 60e3 + 30e3); assert.equal(a5[0].id, 'rem|' + t + '|5');
  const a0 = await at('b1', t + 20e3); assert.equal(a0[0].id, 'rem|' + t + '|0'); assert.equal(a0[0].tag, 'HIGH IMPACT · RELEASE NOW');
  assert.equal((await at('b1', t - 9 * 60e3)).length, 0, 'between the moments, nothing');
  assert.equal((await at('b1', t + 20 * 60e3)).filter(a => a.id.startsWith('rem|' + t)).length, 0, 'long after, nothing');
});

test('no D1 binding: the answer says so in errors, still HTTP 200, and the calendar alerts still work', async () => {
  assert.ok(first);
  const r = await call('c1', iso(first.t - 5 * 60e3 + 30e3), '/alerts', {});
  assert.equal(r.status, 200);
  assert.equal(r.j.errors.length, 1); assert.ok(r.j.errors.every(e => /D1/.test(e)));   // one read now (FinancialJuice); the Walter read was removed
  assert.ok(r.j.alerts.some(a => a.kind === 'remind'));
});

test('a bad since is treated as no filter; the route is GET only data and never writes', async () => {
  const env = { DB: d1() }, now = Date.parse('2026-11-24T14:00:00Z');
  addPost(env, 'FinancialJuice', 7, now - 5e3, 'x post');
  const r = await call('d1', iso(now), '/alerts?since=banana', env);
  assert.equal(r.j.since, 0); assert.ok(r.j.alerts.some(a => a.id === 'fj:7'));
  const rows = env.DB.db.prepare('SELECT COUNT(*) n FROM tg_posts').get().n; assert.equal(rows, 1, 'reading alerts writes no rows');
});
