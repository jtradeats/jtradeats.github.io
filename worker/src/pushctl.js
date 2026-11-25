// pushctl.js: the push control center (25 Nov). Three things, all shared by every phone because they live in the Worker, not in a device:
//   1. a master switch for push alerts, and a choice of which release reminders (15 min, 5 min, at the release) are sent;
//   2. applySettings(list, settings), the filter index.js puts in front of pushNew and GET /alerts;
//   3. the list of devices that are registered for push (from the subscription rows push.js keeps), with the labels and warnings the page shows, and removal.
// Settings are one small KV key (push:settings), written only when something changes. The kind switches (fj, remind, release, fix) stay in push.js (loadPrefs, savePrefs).
// Switching something on records the moment (`from`), so only what happens afterwards is sent: a master switch turned back on does not release a backlog.

import { REM, REM_MENU } from './alerts.js';

export const SET_KV = 'push:settings';
export const REMIND_MINS = REM_MENU;     // the reminder times the control center offers (alerts.js): 60, 30, 15, 10, 5 and 2 minutes before, and at the release
export const REMIND_DEFAULT = REM;       // the ones that are on until someone ticks more: 15 minutes before, 5 minutes before, and at the release

const fresh = () => ({ v: 1, master: true, payload: false, remind: Object.fromEntries(REMIND_MINS.map(m => [m, REMIND_DEFAULT.includes(m)])), from: {}, at: 0 });
function norm(j) {
  const st = fresh();
  if (!j || j.v !== 1) return st;
  st.master = j.master !== false;
  st.payload = j.payload === true;   // the alert text travels inside the push: off until it has been tried on the phone
  for (const m of REMIND_MINS) st.remind[m] = j.remind && typeof j.remind[m] === 'boolean' ? j.remind[m] : REMIND_DEFAULT.includes(m);   // a time never chosen is on only if it is one of the defaults
  st.from = j.from && typeof j.from === 'object' ? { ...j.from } : {};
  st.at = Number(j.at) || 0;
  return st;
}

let memo = null;   // { at, st }: other isolates see a change within SET_TTL
const SET_TTL = 10000;
export async function loadSettings(env, now = Date.now()) {
  if (memo && now - memo.at < SET_TTL) return memo.st;
  let st = fresh();
  if (env && env.MARKET_KV) { try { st = norm(await env.MARKET_KV.get(SET_KV, 'json')); } catch (_) { /* defaults */ } }
  memo = { at: now, st };
  return st;
}
// patch: { master?: boolean, payload?: boolean, remind?: { 60?: boolean, 30?: boolean, 15?: boolean, 10?: boolean, 5?: boolean, 2?: boolean, 0?: boolean } }. valid = the patch held something this module owns; changed = it altered a value.
export async function saveSettings(env, patch, now = Date.now()) {
  const st = JSON.parse(JSON.stringify(await loadSettings(env, now)));
  let valid = false, changed = false;
  if (patch && typeof patch.master === 'boolean') {
    valid = true;
    if (patch.master !== st.master) { st.master = patch.master; if (patch.master) st.from.master = now; changed = true; }
  }
  if (patch && typeof patch.payload === 'boolean') {
    valid = true;
    if (patch.payload !== st.payload) { st.payload = patch.payload; changed = true; }
  }
  if (patch && patch.remind && typeof patch.remind === 'object') {
    for (const m of REMIND_MINS) {
      if (typeof patch.remind[m] !== 'boolean') continue;
      valid = true;
      if (patch.remind[m] !== st.remind[m]) { st.remind[m] = patch.remind[m]; if (patch.remind[m]) st.from['r' + m] = now; changed = true; }
    }
  }
  if (changed) {
    st.at = now;
    if (!(env && env.MARKET_KV)) return { valid, changed: false, st: await loadSettings(env, now), saved: false };
    try { await env.MARKET_KV.put(SET_KV, JSON.stringify(st)); } catch (_) { return { valid, changed: false, st: await loadSettings(env, now), saved: false }; }
    memo = { at: now, st };
  }
  return { valid, changed, st, saved: true };
}

// Which reminder an alert is, from the words alerts.js and the page use: "release in 15 min", "release in 5 min", "release now". null = not a reminder we can place.
export function remindMinutes(a) {
  const id = /^rem\|\d+\|(\d+)$/.exec(String((a && a.id) || ''));   // the id carries the time the reminder was made for. The words carry the minutes left when it was built, which is 14 for a 15-minute reminder built 90 s late, so the words alone let an unticked reminder through
  if (id) return +id[1];
  const t = [a && a.pt, a && a.tag, a && a.h, a && a.title, a && a.nt].filter(Boolean).join(' ');
  const m = /release in (\d+)\s*min/i.exec(t);
  if (m) return +m[1];
  if (/release now|at (the )?release/i.test(t)) return 0;
  return null;
}
export const remindWanted = st => !!st.master && REMIND_MINS.some(m => st.remind[m]);
export const wantedMins = st => (st && st.master ? REMIND_MINS.filter(m => st.remind[m]) : []);   // the ticked reminder times
export function applySettings(list, st) {
  if (!Array.isArray(list)) return list;
  return list.filter(a => {
    if (!a || a.kind === 'test') return true;   // a test alert always arrives
    if (!st.master) return false;
    if (st.from.master && a.t < st.from.master) return false;
    if (a.kind === 'remind') {
      const m = remindMinutes(a);
      if (m !== null && REMIND_MINS.includes(m)) {
        if (!st.remind[m]) return false;
        const f = st.from['r' + m];
        if (f && a.t < f) return false;
      }
    }
    return true;
  });
}

// ---- devices ----
const pick = (o, re) => { for (const k of Object.keys(o)) if (re.test(k) && o[k] != null && o[k] !== '') return o[k]; return null; };
const asMs = v => {
  if (v == null) return null;
  let n = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : Date.parse(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;   // seconds or milliseconds
};
export const epOf = r => (typeof r === 'string' ? r : String(pick(r || {}, /endpoint/i) || ''));
export async function deviceId(ep) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(ep)));
  return [...new Uint8Array(h)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}
export function serviceOf(ep) {
  let h = '';
  try { h = new URL(ep).host; } catch (_) { return 'unknown push service'; }
  if (/push\.apple\.com$/.test(h)) return 'Apple push';
  if (/googleapis\.com$|google\.com$/.test(h)) return 'Google push';
  if (/mozilla\.(com|org)$/.test(h)) return 'Mozilla push';
  if (/windows\.com$/.test(h)) return 'Microsoft push';
  return h;
}
export function uaLabel(ua) {
  const u = String(ua || '');
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows PC' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Linux|X11/.test(u) ? 'Linux' : '';
  if (!os) return '';
  const v = /OS (\d+)[_.](\d+)/.exec(u);
  const ios = (os === 'iPhone' || os === 'iPad') && v ? ' (iOS ' + v[1] + '.' + v[2] + ')' : '';
  const br = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\/|CriOS\//.test(u) ? 'Chrome' : /Version\/[\d.]+.*Safari\//.test(u) ? 'Safari' : '';
  return os + ios + (br && os !== 'iPhone' && os !== 'iPad' ? ' · ' + br : '');
}
// rows: whatever push.js loadSubs returns (an endpoint string or an object with an endpoint field). Field names are read by pattern, so the list works with the columns push.js has.
export async function listDevices(rows, now, thisEp) {
  const thisId = thisEp ? await deviceId(thisEp) : null, out = [];
  for (const r of rows || []) {
    const ep = epOf(r);
    if (!ep) continue;
    const o = typeof r === 'object' && r ? r : {};
    const ua = pick(o, /^(ua|user.?agent|agent)$/i), added = asMs(pick(o, /^(created|created.?at|added|first|first.?seen|since|ts|t|at)$/i)),
      lastOk = asMs(pick(o, /(last.?ok|ok.?at|last.?sent|sent.?at|last.?push|last.?success|success)/i)),
      seen = asMs(pick(o, /(last.?seen|seen|updated|renewed)/i)), err = pick(o, /(last.?err|error)/i);
    const id = await deviceId(ep), latest = Math.max(added || 0, lastOk || 0, seen || 0);
    out.push({ id, label: uaLabel(ua) || 'Unknown device', service: serviceOf(ep), added, seen, lastOk, lastErr: err ? String(err).slice(0, 80) : null,
      current: id === thisId, staleDays: latest ? Math.floor((now - latest) / 864e5) : null, dup: 1, _k: (uaLabel(ua) || '?') + '|' + serviceOf(ep), _latest: latest });
  }
  const n = {};
  for (const d of out) n[d._k] = (n[d._k] || 0) + 1;
  for (const d of out) { d.dup = n[d._k]; delete d._k; }
  out.sort((a, b) => (b.current - a.current) || (b._latest - a._latest));
  for (const d of out) delete d._latest;
  return out;
}
