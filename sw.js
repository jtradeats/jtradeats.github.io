/* sw.js: the dashboard's phone alerts (P8.34 stage 3). Lives in the repo root next to news.html.
   It does ONE job: when the Worker sends an (empty) push, ask the Worker which alerts are new and show one notification for each.
   It has no fetch handler, caches no pages and is registered only for /news.html, so it cannot touch the dashboard's loading or the journal pages.
   The state it keeps (which alert ids it has already shown) lives in the Cache API under /__state, which only this worker reads. */
'use strict';
const VER = '2026-11-26 payload 2';   // shown in the dashboard's Phone alerts panel, so a stale worker is easy to spot
const API = 'https://market-dashboard.jtradeats.workers.dev';
const PAGE = '/news.html', ICON = '/icons/icon-192.png';
const CACHE = 'phone-alerts-v1', STATE = '/__state', MAX_IDS = 300, MAX_SHOWN = 4, FETCH_MS = 8000, BASELINE_MS = 3 * 60e3;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function loadState() {
  try { const r = await (await caches.open(CACHE)).match(STATE); const s = r ? await r.json() : null; if (s && Array.isArray(s.ids)) return s; } catch (e) { /* start again */ }
  return { init: false, ids: [] };
}
async function saveState(s) { try { await (await caches.open(CACHE)).put(STATE, new Response(JSON.stringify(s))); } catch (e) { /* the next push shows at worst a repeat */ } }

async function fetchAlerts() {
  const c = new AbortController(), t = setTimeout(() => c.abort(), FETCH_MS);
  try {
    const r = await fetch(API + '/alerts', { cache: 'no-store', signal: c.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.alerts) ? j.alerts : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}
const data = { url: PAGE };
const show = (title, body, tag) => self.registration.showNotification(title, { body, tag, icon: ICON, data });

// iOS withdraws permission from a site whose pushes show nothing, so every push shows something. When there is nothing new the notification is shown and removed at once.
// A second push right behind one that already showed everything (two pollers in the same minute, or two pushes delivered together after the phone slept) used to leave a blank
// "Market Dashboard" on the lock screen. Now the newest notification that is still on the screen is shown again in place (same tag, silent), so nothing is added and the push still shows
// something. Only when nothing of ours is on the screen any more does the old blank-and-close fallback run.
async function flash() {
  try {
    const on = (await self.registration.getNotifications()).filter(n => n.tag !== 'noop');
    on.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const last = on[0];
    if (last) return await self.registration.showNotification(last.title, { body: last.body, tag: last.tag, icon: ICON, data: last.data, silent: true, ...(last.timestamp ? { timestamp: last.timestamp } : {}) });
  } catch (e) { /* fall through to the blank notification */ }
  await self.registration.showNotification('Market Dashboard', { body: ' ', tag: 'noop', silent: true, icon: ICON });
  for (const n of await self.registration.getNotifications({ tag: 'noop' })) n.close();
}

async function run() {
  const st = await loadState(), all = await fetchAlerts();
  if (!all) return show('Market Dashboard', 'New alert. Open the dashboard to read it.', 'fallback');   // the list could not be read: say so, the next push shows what was missed
  const now = Date.now();
  let fresh = all.filter(a => !st.ids.includes(a.id));
  if (!st.init) fresh = fresh.filter(a => a.kind === 'test' || (!a.sticky && a.t > now - BASELINE_MS));   // no baseline yet (first push): not the whole backlog
  st.init = true;
  st.ids = [...new Set([...st.ids, ...all.map(a => a.id)])].slice(-MAX_IDS);
  await saveState(st);   // before showing: a failure while showing never repeats an alert
  if (!fresh.length) return flash();
  fresh.sort((a, b) => a.t - b.t);
  const shown = fresh.slice(-MAX_SHOWN), more = fresh.slice(0, fresh.length - shown.length);
  if (more.length) await show(more.length + ' earlier alerts', more.map(a => (a.hot ? '\u2757 ' : '') + a.h).join('\n'), 'digest');   // a burst: the oldest become one line each in one notification, a red-marked one keeps its leading red exclamation mark
  for (const a of shown) await show(a.pt || a.src || 'Market Dashboard', a.pb || a.h || '', a.id);
}

// A push that carries its alerts (push.js, switched on in the control center) shows exactly those: each one under its own tag, so a repeat replaces it instead of adding to it, and a push is never
// left with nothing to show. An empty push (a phone that has not given its keys, or the switch off) takes the old way: ask /alerts what is new.
async function showPayload(items) {
  const st = await loadState();
  st.init = true;
  st.ids = [...new Set([...st.ids, ...items.map(x => x.id)])].slice(-MAX_IDS);   // the old way will not show these again
  await saveState(st);
  for (const x of items) await show(x.t || 'Market Dashboard', x.b || '', x.id);
}
async function onPush(e) {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch (x) { d = null; }
  if (d && d.v === 1 && Array.isArray(d.a) && d.a.length) return showPayload(d.a.filter(x => x && x.id));
  return run();
}
self.addEventListener('push', e => e.waitUntil(onPush(e)));
// the page tells the worker right after subscribing: everything that exists now counts as already seen
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'ver') { const m = { type: 'ver', v: VER }; try { if (e.ports && e.ports[0]) e.ports[0].postMessage(m); else e.source.postMessage(m); } catch (x) { /* no page to answer */ } return; }   // the page's reply port first: it works whatever the page's message queue is doing
  if (!e.data || e.data.type !== 'baseline') return;
  e.waitUntil((async () => { const all = await fetchAlerts(); await saveState({ init: true, ids: (all || []).map(a => a.id).slice(-MAX_IDS) }); })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes(PAGE) && 'focus' in c) {
        await c.focus();
        try { c.postMessage({ type: 'alerts' }); } catch (x) { /* the page then shows the alerts the next time it is opened */ }   // the page shows its alerts panel (news.html, alertsCatchUp)
        return;
      }
    }
    return self.clients.openWindow(PAGE + '#alerts');   // a closed app opens with the alerts panel
  })());
});
