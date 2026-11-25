// P8.34 stage 3: Web Push from the Worker to the Home Screen app (the phone).
// How it works, in one paragraph: the phone subscribes once (the page's "Phone alerts" panel) and the Worker keeps the subscription's address in D1.
// When a poller finds an alert nobody has been told about, the Worker sends the push service (Apple's, for an iPhone) an EMPTY push, signed with the
// Worker's own VAPID key (RFC 8292). The push wakes sw.js on the phone, which asks GET /alerts for what is new and shows one notification per alert.
// An empty push needs no payload encryption, costs almost no CPU (one signature per push service per 12 hours) and one subrequest per phone.
// Because the phone reads the list itself, a push that is lost or late is made up by the next one: nothing depends on one message arriving.
// Secrets: PUSH_KEY (a Cloudflare secret you choose) pairs the page with the Worker; the VAPID private key is made inside the Worker on first setup and
// kept in KV ("push:vapid"). Neither is in the repository. Every function is safe without D1 or KV and never throws.
import { ensurePosts } from './posts.js';
import { PREF_KINDS, defaultPrefs, normPrefs, filterPrefs, anyKindOn } from './alerts.js';

export const VAPID_KV = 'push:vapid';
export const PREFS_KV = 'push:prefs';               // which alert kinds reach the phone (stage 4): one small JSON value, written only when a switch is changed
export const PREFS_REUSE_MS = 15000;                // a Worker instance re-reads the switches at most this often; a change made through PUT is seen at once by the instance that took it
export const JWT_TTL_S = 12 * 3600;                 // a VAPID token may live up to 24 h; 12 h is cached and reused
export const PUSH_TTL_S = 600;                      // the push service drops an undelivered push after 10 minutes (alerts go stale)
export const SENT_KEEP_MS = 2 * 86400000;           // alert ids are remembered for two days
export const PUSH_TOPIC = 'dashboard-alerts';           // RFC 8030 Topic: a push still waiting at the push service is replaced by the next one with the same topic. The phone reads the whole list when it wakes, so two waiting pushes become one and nothing is lost
// only real push services are ever called: the address comes from the phone, so it is checked (the page's pairing key already limits who can save one)
export const PUSH_HOSTS = /(^|\.)push\.apple\.com$|(^|\.)googleapis\.com$|(^|\.)push\.services\.mozilla\.com$|(^|\.)notify\.windows\.com$/;

const enc = new TextEncoder();
export const b64u = buf => { const b = new Uint8Array(buf); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = s => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'), p = t + '='.repeat((4 - t.length % 4) % 4), r = atob(p), o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; };
const db = env => (env && env.DB && typeof env.DB.prepare === 'function' ? env.DB : null);
const state = { err: null, jwt: new Map(), vapid: null, prefs: null };
export const pushError = () => state.err;
export const _resetPush = () => { state.err = null; state.jwt.clear(); state.vapid = null; state.prefs = null; };
const fail = e => { state.err = String(e && e.message).slice(0, 120); return null; };

// ---- the pairing key ----
export function checkKey(env, given) {   // constant time; false when PUSH_KEY is not set or differs
  const a = enc.encode(String(given || '')), b = enc.encode(String((env && env.PUSH_KEY) || ''));
  if (!b.length) return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] || 0) ^ (b[i] || 0);
  return d === 0;
}

// ---- VAPID keys: made once, kept in KV ----
export async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]));   // the 65-byte uncompressed point: the "application server key" the phone subscribes with
  return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, pub, made: Date.now() };
}
export async function getVapid(env, create) {
  if (state.vapid) return state.vapid;
  if (!env || !env.MARKET_KV) { state.err = 'no KV binding for the VAPID key'; return null; }
  try {
    let v = await env.MARKET_KV.get(VAPID_KV, 'json');
    if (!v && create) { v = await makeVapid(); await env.MARKET_KV.put(VAPID_KV, JSON.stringify(v)); }
    if (v && v.jwk && v.pub) state.vapid = v;
    return state.vapid;
  } catch (e) { return fail(e); }
}
async function signJwt(v, aud, sub, now) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + JWT_TTL_S, sub })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));   // 64 bytes r||s, which is the JWT format
  return head + '.' + body + '.' + b64u(sig);
}
export async function vapidHeader(v, endpoint, sub, now = Date.now()) {
  const aud = new URL(endpoint).origin, c = state.jwt.get(aud);
  let t = c && c.exp - now > 3600e3 ? c.t : null;
  if (!t) { t = await signJwt(v, aud, sub, now); state.jwt.set(aud, { t, exp: now + JWT_TTL_S * 1000 }); }
  return 'vapid t=' + t + ', k=' + v.pub;
}

// ---- which kinds reach the phone (stage 4) ----
// Kept in KV, not D1: it is one small value that changes rarely, and it needs no table. Without KV, or when the read fails, every kind stays on (the behaviour before stage 4):
// a lost switch must never mean a lost alert.
export async function loadPrefs(env, now = Date.now()) {
  if (state.prefs && now - state.prefs.at < PREFS_REUSE_MS) return state.prefs.v;
  let v = defaultPrefs();
  if (env && env.MARKET_KV) {
    try { v = normPrefs(await env.MARKET_KV.get(PREFS_KV, 'json')); } catch (e) { fail(e); if (state.prefs) return state.prefs.v; }
  }
  state.prefs = { v, at: now };
  return v;
}
// change some switches: kinds = { fj: false, ... } (only the four known kinds count; anything else is ignored). A kind going from off to on records the moment,
// so what happened while it was off is not sent afterwards. Returns the new prefs, or null when nothing valid was given or KV could not be written.
export async function savePrefs(env, kinds, now = Date.now()) {
  if (!env || !env.MARKET_KV || !kinds || typeof kinds !== 'object') return null;
  const given = PREF_KINDS.filter(k => typeof kinds[k] === 'boolean');
  if (!given.length) return null;
  try {
    const cur = normPrefs(await env.MARKET_KV.get(PREFS_KV, 'json'));
    for (const k of given) { if (kinds[k] && !cur.kinds[k]) cur.at[k] = now; cur.kinds[k] = kinds[k]; }
    await env.MARKET_KV.put(PREFS_KV, JSON.stringify(cur));
    state.prefs = { v: cur, at: now };
    return cur;
  } catch (e) { fail(e); return null; }
}

// ---- subscriptions and the "already told" list (D1) ----
export function validEndpoint(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.test(x.hostname) && u.length <= 600; } catch (e) { return false; }
}
export async function saveSub(env, endpoint, ua, now = Date.now()) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return false;
  try {
    await d.prepare('INSERT INTO push_subs (endpoint, created, ua, fails) VALUES (?1, ?2, ?3, 0) ON CONFLICT(endpoint) DO UPDATE SET fails = 0, last_err = NULL, ua = excluded.ua').bind(endpoint, now, String(ua || '').slice(0, 80)).run();
    return true;
  } catch (e) { fail(e); return false; }
}
export async function dropSub(env, endpoint) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return false;
  try { await d.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(endpoint).run(); return true; } catch (e) { fail(e); return false; }
}
export async function loadSubs(env) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return [];
  try { return ((await d.prepare('SELECT endpoint, created, last_ok, last_err, last_err_at, fails FROM push_subs ORDER BY created').all()).results || []).map(x => ({ ...x })); } catch (e) { fail(e); return []; }
}
const MAXQ = 80;
async function sentSet(d, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += MAXQ) {
    const part = ids.slice(i, i + MAXQ);
    const r = await d.prepare('SELECT id FROM alert_sent WHERE id IN (' + part.map((_, k) => '?' + (k + 1)).join(',') + ')').bind(...part).all();
    for (const x of r.results || []) out.add(x.id);
  }
  return out;
}
// true when at least one of these ids has not been sent yet (and someone is subscribed): the quiet poller's "is it worth building the calendar?"
export async function anyUnsent(env, ids) {
  const d = db(env);
  if (!d || !ids.length || !(await ensurePosts(env))) return false;
  try {
    if (!(await d.prepare('SELECT 1 AS x FROM push_subs LIMIT 1').first())) return false;
    return (await sentSet(d, ids)).size < ids.length;
  } catch (e) { fail(e); return false; }
}
// claim the alerts nobody has been told about: INSERT OR IGNORE, so two pollers in the same minute cannot both send the same alert
export async function claim(env, alerts, now = Date.now()) {
  const d = db(env);
  if (!d || !alerts.length || !(await ensurePosts(env))) return [];
  try {
    const seen = await sentSet(d, alerts.map(a => a.id)), todo = alerts.filter(a => !seen.has(a.id)), won = [];
    if (!todo.length) return [];
    const res = await d.batch(todo.map(a => d.prepare('INSERT OR IGNORE INTO alert_sent (id, t, at) VALUES (?1, ?2, ?3)').bind(a.id, a.t, now)));
    todo.forEach((a, i) => { const c = res && res[i] && res[i].meta ? res[i].meta.changes : 1; if (c !== 0) won.push(a); });
    if (Math.floor(now / 60000) % 60 === 0) await d.prepare('DELETE FROM alert_sent WHERE at < ?1').bind(now - SENT_KEEP_MS).run();
    return won;
  } catch (e) { fail(e); return []; }
}
export async function loadTests(env, since) {   // the "send a test" alerts of the last minutes, so GET /alerts can list them
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return [];
  try { return ((await d.prepare("SELECT t FROM alert_sent WHERE id >= 'test|' AND id < 'test}' AND t > ?1 ORDER BY t DESC LIMIT 3").bind(since).all()).results || []).map(x => x.t); } catch (e) { fail(e); return []; }
}
export async function recordTest(env, t) {
  const d = db(env);
  if (!d || !(await ensurePosts(env))) return false;
  try { await d.prepare('INSERT OR IGNORE INTO alert_sent (id, t, at) VALUES (?1, ?2, ?2)').bind('test|' + t, t).run(); return true; } catch (e) { fail(e); return false; }
}

// ---- sending ----
// one empty push to one subscription. 201 = accepted. 404 and 410 = the phone has unsubscribed or the subscription expired: forget it.
export async function sendOne(env, v, endpoint, now = Date.now()) {
  try {
    const sub = (env && env.PUSH_SUB) || 'https://jtradeats.github.io';
    const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidHeader(v, endpoint, sub, now), TTL: String(PUSH_TTL_S), Urgency: 'high', Topic: PUSH_TOPIC } });
    const text = r.ok ? '' : String(await r.text().catch(() => '')).slice(0, 80);
    return { ok: r.status === 201 || r.status === 200 || r.status === 202, status: r.status, gone: r.status === 404 || r.status === 410, err: r.ok ? null : 'HTTP ' + r.status + (text ? ' ' + text : '') };
  } catch (e) { return { ok: false, status: 0, gone: false, err: String(e && e.message).slice(0, 80) }; }
}
export async function sendAll(env, now = Date.now()) {
  const out = { subs: 0, sent: 0, failed: 0, removed: 0, results: [], error: null };
  const v = await getVapid(env, false);
  if (!v) { out.error = 'no VAPID key yet (run the page\'s phone setup)'; return out; }
  const subs = await loadSubs(env), d = db(env);
  out.subs = subs.length;
  for (const s of subs) {
    if (!validEndpoint(s.endpoint)) { await dropSub(env, s.endpoint); out.removed++; continue; }
    const r = await sendOne(env, v, s.endpoint, now);
    out.results.push({ host: new URL(s.endpoint).hostname, status: r.status, ok: r.ok, err: r.err });
    try {
      if (r.ok) { out.sent++; await d.prepare('UPDATE push_subs SET last_ok = ?2, fails = 0, last_err = NULL WHERE endpoint = ?1').bind(s.endpoint, now).run(); }
      else if (r.gone) { out.removed++; await dropSub(env, s.endpoint); }
      else { out.failed++; await d.prepare('UPDATE push_subs SET last_err = ?2, last_err_at = ?3, fails = fails + 1 WHERE endpoint = ?1').bind(s.endpoint, r.err, now).run(); }
    } catch (e) { fail(e); }
  }
  return out;
}
// called by the pollers with a function that builds the alerts they know about (built only when someone is subscribed)
export async function pushNew(env, makeAlerts, now = Date.now()) {
  const out = { subs: 0, fresh: 0, sent: 0, failed: 0, removed: 0, skipped: null };
  try {
    const subs = await loadSubs(env);
    out.subs = subs.length;
    if (!subs.length) { out.skipped = 'no subscribers'; return out; }
    const prefs = await loadPrefs(env, now);
    if (!anyKindOn(prefs)) { out.skipped = 'every kind is switched off'; return out; }
    const from = Math.min(...subs.map(s => s.created)) - 60000;   // what happened before the first subscription is not sent
    // the switches are applied BEFORE claiming: an alert of a kind that is off is not marked as sent and sends no push, because a push that leaves nothing to show is a silent push
    const cand = filterPrefs((await makeAlerts()).filter(a => a.sticky || a.t >= from), prefs);
    const fresh = await claim(env, cand, now);
    out.fresh = fresh.length;
    if (!fresh.length) { out.skipped = 'nothing new'; return out; }
    const r = await sendAll(env, now);
    out.sent = r.sent; out.failed = r.failed; out.removed = r.removed; out.skipped = r.error;
  } catch (e) { fail(e); out.skipped = 'error: ' + state.err; }
  return out;
}
export async function pushHealth(env, now = Date.now()) {
  const subs = await loadSubs(env), v = await getVapid(env, false), age = t => (t ? Math.round((now - t) / 1000) : null);
  return {
    key_set: !!(env && env.PUSH_KEY), vapid: !!v, subs: subs.length, kinds: (await loadPrefs(env, now)).kinds,
    list: subs.map(s => { let host = '?'; try { host = new URL(s.endpoint).hostname; } catch (e) { /* kept */ } return { host, created_age_s: age(s.created), last_ok_age_s: age(s.last_ok), fails: s.fails || 0, last_err: s.last_err || null }; }),
    error: state.err,
  };
}
