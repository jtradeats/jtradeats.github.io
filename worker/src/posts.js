// Telegram posts kept in D1 (plan P8.31), so a feed is never limited to what one isolate's memory or one KV snapshot happened to hold.
// Until now the window (the newest 50 posts) lived in memory and was copied to KV every 15 minutes at most. A Worker that nobody polled for hours
// lost the posts that scrolled past, and KV's 1,000 free writes a day could not hold a copy per minute. D1 allows 100,000 row writes a day:
// a new post is one row, so about 500 a day for both channels. Table tg_posts (channel, id, time, JSON of the post); meta holds the poller's heartbeats.
// Every function here is safe to call without a D1 binding and never throws: the feed then works from memory and KV exactly as before.

export const POSTS_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS tg_posts (ch TEXT NOT NULL, id INTEGER NOT NULL, t INTEGER, j TEXT NOT NULL, PRIMARY KEY (ch, id))',
  'CREATE TABLE IF NOT EXISTS poll_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS actual_lag (id TEXT PRIMARY KEY, rel INTEGER NOT NULL, seen INTEGER NOT NULL, src TEXT)',
  'CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, created INTEGER NOT NULL, ua TEXT, last_ok INTEGER, last_err TEXT, last_err_at INTEGER, fails INTEGER NOT NULL DEFAULT 0)',   // phone subscriptions (P8.34 stage 3)
  'CREATE TABLE IF NOT EXISTS alert_sent (id TEXT PRIMARY KEY, t INTEGER NOT NULL, at INTEGER NOT NULL)',   // alerts already pushed: nothing fires twice
];
export const POSTS_KEEP_ROWS = 800;   // per channel: about two to three days of FinancialJuice

const state = { err: null };
const readyBy = new WeakMap();   // one schema check per D1 binding
const db = env => (env && env.DB && typeof env.DB.prepare === 'function' ? env.DB : null);

// creates the tables once per isolate (a no-op when they exist: no rows are written)
export function ensurePosts(env) {
  const d = db(env);
  if (!d) return Promise.resolve(false);
  let r = readyBy.get(d);
  if (!r) {
    r = Promise.all(POSTS_SCHEMA.map(s => d.prepare(s).run())).then(() => true).catch(e => { state.err = String(e && e.message).slice(0, 120); readyBy.delete(d); return false; });
    readyBy.set(d, r);
  }
  return r;
}
export const _resetPosts = () => { state.err = null; };   // tests
export const postsError = () => state.err;

const slim = p => { const o = { id: p.id, t: p.t ?? null, text: p.text, url: p.url, media: !!p.media }; if (p.hot) o.hot = true; if (p.bang) o.bang = true; if (p.breaking) o.breaking = true; return o; };

// Saves posts. An existing row is rewritten only when its content changed (an edit, or the hot flag), so a re-read costs no row writes.
export async function savePosts(env, ch, posts) {
  const d = db(env);
  if (!d || !posts || !posts.length || !(await ensurePosts(env))) return 0;
  try {
    const st = d.prepare('INSERT INTO tg_posts (ch, id, t, j) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(ch, id) DO UPDATE SET t = excluded.t, j = excluded.j WHERE j != excluded.j');
    const stmts = posts.map(p => { const s = slim(p); return st.bind(ch, s.id, s.t, JSON.stringify(s)); });
    if (typeof d.batch === 'function') await d.batch(stmts); else for (const s of stmts) await s.run();
    return posts.length;
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return 0; }
}

// The newest n posts of a channel, newest first, or null when D1 cannot be read (the caller falls back to KV).
export async function loadPosts(env, ch, n) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return null;
  try {
    const r = await d.prepare('SELECT j FROM tg_posts WHERE ch = ?1 ORDER BY id DESC LIMIT ?2').bind(ch, n).all();
    return (r.results || []).map(x => JSON.parse(x.j));
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return null; }
}

// keeps the newest `keep` rows of a channel; run about once an hour
export async function prunePosts(env, ch, keep = POSTS_KEEP_ROWS) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return false;
  try {
    await d.prepare('DELETE FROM tg_posts WHERE ch = ?1 AND id < COALESCE((SELECT id FROM tg_posts WHERE ch = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2), 0)').bind(ch, keep).run();
    return true;
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return false; }
}

// per-channel counts for /health
export async function postsSummary(env) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return null;
  try {
    const r = await d.prepare('SELECT ch, COUNT(*) AS n, MAX(id) AS newest, MAX(t) AS newest_t FROM tg_posts GROUP BY ch').all();
    return Object.fromEntries((r.results || []).map(x => [x.ch, { rows: x.n, newest_id: x.newest, newest_t: x.newest_t }]));
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return null; }
}

// the poller's heartbeats (when each kind of run last finished), so /health shows that the cron is alive
export async function beat(env, k, now = Date.now()) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return false;
  try { await d.prepare('INSERT INTO poll_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, now).run(); return true; } catch (e) { state.err = String(e && e.message).slice(0, 120); return false; }
}
export async function beats(env) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return null;
  try { const r = await d.prepare('SELECT k, v FROM poll_meta').all(); return Object.fromEntries((r.results || []).map(x => [x.k, x.v])); } catch (e) { state.err = String(e && e.message).slice(0, 120); return null; }
}

// ---- the actuals lag log (plan P8.18, O60): per release row, when it came out, when any source first returned an actual, and which one ----
// INSERT OR IGNORE: the first sighting is kept and a later isolate that sees the same actual writes nothing. About 5 to 15 rows a day; the newest 200 are kept.
export async function recordLag(env, rows) {
  const d = db(env);
  if (!d || !rows.length || !(await ensurePosts(env))) return false;
  try {
    await d.batch(rows.map(r => d.prepare('INSERT OR IGNORE INTO actual_lag (id, rel, seen, src) VALUES (?1, ?2, ?3, ?4)').bind(r.id, r.rel, r.seen, r.src)));
    if (Math.floor(rows[0].seen / 60000) % 60 === 0) await d.prepare('DELETE FROM actual_lag WHERE seen < COALESCE((SELECT seen FROM actual_lag ORDER BY seen DESC LIMIT 1 OFFSET 200), 0)').run();
    return true;
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return false; }
}
export async function loadLag(env, n = 30) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return null;
  try {
    const r = await d.prepare('SELECT id, rel, seen, src FROM actual_lag ORDER BY seen DESC LIMIT ?1').bind(n).all();
    return (r.results || []).map(x => ({ id: x.id, release: new Date(x.rel).toISOString().replace(/\.\d+Z$/, 'Z'), lag_s: Math.round((x.seen - x.rel) / 1000), src: x.src }));
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return null; }
}

// when each release row's actual was first seen (ms), for the rows seen after `since`: lets /alerts date a release alert by the sighting, not the print
export async function loadLagSeen(env, since) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return {};
  try {
    const r = await d.prepare('SELECT id, seen FROM actual_lag WHERE seen > ?1').bind(since).all();
    return Object.fromEntries((r.results || []).map(x => [x.id, x.seen]));
  } catch (e) { state.err = String(e && e.message).slice(0, 120); return {}; }
}
