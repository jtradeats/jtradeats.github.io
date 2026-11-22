// P8.34 stage 3: sw.js, the service worker on the phone. It is run in a sandbox that stands in for the browser's worker scope (a push event, fetch, the Cache API,
// registration.showNotification), so what it would show on the phone is checked without a phone. It also checks that sw.js, the page and the manifest agree with each other.
// Run: node --test test/sw.test.mjs   (NEWS_DIR=<folder holding news.html, sw.js, manifest.json> when they are not at ../../ or ../../out/)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';

const dirs = [process.env.NEWS_DIR, new URL('../../', import.meta.url).pathname, new URL('../../out/', import.meta.url).pathname].filter(Boolean);
const dir = dirs.find(d => existsSync(d + 'sw.js') && existsSync(d + 'news.html'));
const skip = dir ? false : 'sw.js and news.html not found next to the worker folder (set NEWS_DIR)';
const SW = dir ? readFileSync(dir + 'sw.js', 'utf8') : '', PAGE = dir ? readFileSync(dir + 'news.html', 'utf8') : '';

// the worker scope: records every notification, keeps a Map as the Cache API, answers /alerts from `world.alerts`
function scope(world) {
  const handlers = {}, shown = [], closed = [], store = new Map(), opened = [];
  const sw = {
    addEventListener: (n, f) => { handlers[n] = f; }, skipWaiting() {}, clients: { claim() {}, matchAll: async () => world.clients || [], openWindow: async u => { opened.push(u); } },
    registration: { showNotification: async (t, o) => { shown.push({ title: t, ...o }); }, getNotifications: async ({ tag }) => shown.filter(n => n.tag === tag).map(n => ({ close() { closed.push(n.tag); } })) },
  };
  const ctx = { self: sw, caches: { open: async () => ({ match: async k => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, r) => { store.set(k, await r.text()); } }) },
    fetch: async (u, o) => { world.fetched.push(String(u)); if (world.down) throw new Error('offline'); if (world.status) return new Response('x', { status: world.status }); return new Response(JSON.stringify({ alerts: world.alerts })); },
    Response, AbortController, setTimeout, clearTimeout, Date, JSON, Math, Set, Array, Object, Promise, URL };
  vm.runInNewContext(SW, ctx);
  const dispatch = async (name, ev) => { const p = []; handlers[name]({ ...ev, waitUntil: x => p.push(x) }); await Promise.all(p); };
  return { shown, closed, store, opened, handlers, push: () => dispatch('push', {}), message: d => dispatch('message', { data: d }), click: () => dispatch('notificationclick', { notification: { close() { closed.push('clicked'); } } }) };
}
const al = (id, t, o = {}) => ({ id, kind: 'wire', t, src: 'Walter Bloomberg', tag: 'NEW POST', h: 'HEAD ' + id, s: '', pt: 'Walter Bloomberg', pb: 'HEAD ' + id, ...o });
const now = Date.now();

test('a push with new alerts: one notification per alert, title and body as the Worker built them, tagged with the alert id, oldest first', { skip }, async () => {
  const world = { fetched: [], alerts: [al('dm:2', now - 20e3, { pb: 'HEADLINE TWO\nthe rest of it' }), al('dm:1', now - 40e3)] }, s = scope(world);
  await s.message({ type: 'baseline' }); world.alerts.unshift(al('dm:3', now - 1e3, { kind: 'remind', pt: 'High impact · release in 5 min', pb: 'CPI m/m\nForecast 0.3%' }));
  await s.push();
  assert.deepEqual(s.shown.map(n => n.tag), ['dm:3'], 'the two alerts that existed at the baseline are not shown again, the new one is');
  assert.equal(s.shown[0].title, 'High impact · release in 5 min'); assert.equal(s.shown[0].body, 'CPI m/m\nForecast 0.3%');
  assert.deepEqual({ ...s.shown[0].data }, { url: '/news.html' }); assert.equal(s.shown[0].icon, '/icons/icon-192.png');
  world.alerts.unshift(al('dm:5', now, { pb: 'FIVE' }), al('dm:4', now - 500));
  await s.push(); assert.deepEqual(s.shown.slice(1).map(n => n.tag), ['dm:4', 'dm:5'], 'oldest first');
  assert.ok(world.fetched.every(u => u === 'https://market-dashboard.jtradeats.workers.dev/alerts'));
});

test('the same alert is never shown twice, even across pushes; a push with nothing new shows and removes a blank notification (iOS needs one per push)', { skip }, async () => {
  const world = { fetched: [], alerts: [al('dm:1', now - 5e3)] }, s = scope(world);
  await s.push(); assert.equal(s.shown.length, 1);
  await s.push();
  assert.equal(s.shown.length, 2); assert.equal(s.shown[1].tag, 'noop'); assert.equal(s.shown[1].silent, true); assert.deepEqual(s.closed, ['noop'], 'removed at once');
});

test('first push with no baseline: only the last 3 minutes and test alerts, never the old backlog, never a sticky correction', { skip }, async () => {
  const world = { fetched: [], alerts: [al('old', now - 10 * 60e3), al('fix|a', now - 60e3, { kind: 'fix', sticky: true }), al('new', now - 30e3), al('test|1', now - 8 * 60e3, { kind: 'test', pt: 'Market Dashboard', pb: 'Test alert' })] }, s = scope(world);
  await s.push();
  assert.deepEqual(s.shown.map(n => n.tag).sort(), ['new', 'test|1']);
});

test('a burst: the newest four are shown on their own and the older ones become one digest line each', { skip }, async () => {
  const world = { fetched: [], alerts: Array.from({ length: 9 }, (_, i) => al('b' + i, now - (9 - i) * 1000, { h: 'HEAD b' + i })) }, s = scope(world);
  await s.message({ type: 'baseline' }); world.alerts.push(...Array.from({ length: 7 }, (_, i) => al('n' + i, now + i * 1000, { h: 'HEAD n' + i, pb: 'BODY n' + i })));
  await s.push();
  assert.equal(s.shown.length, 5); assert.equal(s.shown[0].tag, 'digest'); assert.equal(s.shown[0].title, '3 earlier alerts'); assert.equal(s.shown[0].body, 'HEAD n0\nHEAD n1\nHEAD n2');
  assert.deepEqual(s.shown.slice(1).map(n => n.tag), ['n3', 'n4', 'n5', 'n6']);
});

test('the Worker cannot be reached or answers with an error: a generic notification is shown (never silence), and the next push shows what was missed', { skip }, async () => {
  const world = { fetched: [], alerts: [al('m1', now - 5e3)], down: true }, s = scope(world);
  await s.push(); assert.equal(s.shown.length, 1); assert.equal(s.shown[0].tag, 'fallback'); assert.match(s.shown[0].body, /Open the dashboard/);
  world.down = false; world.status = 500; await s.push(); assert.equal(s.shown[1].tag, 'fallback', 'an HTTP error is the same');
  world.status = 0; await s.push(); assert.deepEqual(s.shown.slice(2).map(n => n.tag), ['m1'], 'recovered: the alert that was missed is shown');
});

test('a tap on a notification closes it and opens or focuses the dashboard page', { skip }, async () => {
  const focused = []; const world = { fetched: [], alerts: [], clients: [{ url: 'https://jtradeats.github.io/index.html', focus: async () => focused.push('journal') }, { url: 'https://jtradeats.github.io/news.html', focus: async () => focused.push('news') }] }, s = scope(world);
  await s.click(); assert.deepEqual(focused, ['news'], 'the dashboard window, not the journal'); assert.ok(s.closed.includes('clicked'));
  const w2 = { fetched: [], alerts: [], clients: [] }, s2 = scope(w2); await s2.click(); assert.deepEqual(s2.opened, ['/news.html']);
});

test('sw.js, news.html and manifest.json agree: same Worker address, same page, same icon, registered for /news.html only; the worker never takes over requests', { skip }, () => {
  assert.match(SW, /const API = 'https:\/\/market-dashboard\.jtradeats\.workers\.dev';/);
  assert.match(PAGE, /const PUSH_API='https:\/\/market-dashboard\.jtradeats\.workers\.dev'/);
  assert.match(PAGE, /register\('\/sw\.js',\{scope:'\/news\.html'\}\)/);
  assert.match(SW, /PAGE = '\/news\.html'/); assert.match(SW, /ICON = '\/icons\/icon-192\.png'/);
  assert.doesNotMatch(SW, /addEventListener\('fetch'/, 'no fetch handler: it cannot touch page loads, the journal, or anything else');
  assert.doesNotMatch(SW, /caches\.(match|keys|delete)|cache\.addAll/);
  const man = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8')); assert.equal(man.start_url, '/news.html');
  assert.ok(man.icons.some(i => i.src === '/icons/icon-192.png'));
});
