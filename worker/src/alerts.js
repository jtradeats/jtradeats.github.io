// P8.34 stage 1: the alerts, decided on the Worker instead of in each open page.
// Until now every alert was made by the page (notify, wireAlert, relCheck, remCheck in news.html): it fired only while the page was awake,
// only for the newest post of a burst, and only on the device that happened to be open. This module holds the same rules as pure functions,
// so one place decides what is an alert; the phone (stage 3, Web Push) and the page (stage 4) both read the same list from GET /alerts.
// The wording, the grouping and the thresholds are copied from the page on purpose, and test/alerts.parity.test.mjs runs the page's own
// functions beside these ones, so a change on one side that is not made on the other fails a test.
//
// Every alert: { id, kind, t, src, tag, h, s, nt, nb, n? }
//   id    stable across calls (a client shows each id once)        kind  wire | fj | remind | release | fix
//   t     when it happened (post time, reminder time, first sighting of the actual)
//   src, tag, h, s   what the page's toast shows (source line, tag line, headline, text)
//   nt, nb           what the page passes to notify() (title, body), which is what a phone notification should show
// Deliberate differences from the page, each one needed because this side keeps no memory between calls:
//   - a post without a time is skipped (nothing to place it in time with);
//   - a release report (jobs, CPI) is one alert for the whole report, not a second alert for rows whose actual arrives a few seconds later;
//   - the page alerts "since I loaded"; here each kind has a freshness limit (TTL) and the client keeps the ids it has shown.

export const GROUP_MS = 120000, GROUP_SIM = 0.6, WH_CUT = 160;   // same values as the page
export const REM = [15, 5, 0];                                   // minutes before a high-impact release
export const TTL = {
  wire: 15 * 60e3,     // a post older than this is not an alert any more
  rem: 5 * 60e3,       // the page fires within 150 s of the moment; here the poller may be a minute or two late
  rel: 45 * 60e3,      // the page: the actual must appear within 45 min of the print
  fix: 6 * 36e5,       // the page: a corrected figure within 6 h of the release
};

// ---- helpers copied from the page (news.html) ----
const numOf = v => { if (v == null) return NaN; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const wtok = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9.%$ ]+/g, ' ').split(/\s+/).filter(x => x.length > 2));
const wsim = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
export function wireGroup(nw, recent, now) {   // nw newest first -> [{p: newest post of the story, n, t, tk, ps: every post, oldest first}] newest first
  const out = [];
  for (const p of nw.slice().reverse()) {
    const t = p.t || now, tk = wtok(p.text);
    const done = recent.find(r => Math.abs(t - r.t) <= GROUP_MS && wsim(tk, r.tk) >= GROUP_SIM);
    if (done) { done.t = Math.max(done.t, t); continue; }
    const g = out.find(g => Math.abs(t - g.t) <= GROUP_MS && wsim(tk, g.tk) >= GROUP_SIM);
    if (g) { g.p = p; g.n++; g.t = t; g.ps.push(p); } else out.push({ p, n: 1, t, tk, ps: [p] });
  }
  return out.reverse();
}
export const wireSplit = p => {
  const full = (p.text || '').trim();
  if (!full) return { head: p.media ? '[media post]' : '[empty post]', rest: '', cut: false };
  const nl = full.indexOf('\n'), first = (nl < 0 ? full : full.slice(0, nl)).trim();
  if (first.length > WH_CUT) return { head: first.slice(0, WH_CUT).replace(/\s+$/, '') + '…', rest: full, cut: true };
  return { head: first, rest: nl < 0 ? '' : full.slice(nl + 1).trim(), cut: false };
};
export function scenIdx(e) {   // 0 above forecast, 1 in line, 2 below; rows with no forecast compare with the previous figure; -1 until an actual exists
  if (e.ac == null) return -1;
  const a = numOf(e.ac); let f = numOf(e.fc); if (isNaN(f)) f = numOf(e.pv);
  if (isNaN(a) || isNaN(f)) return -1;
  return a === f ? 1 : a > f ? 0 : 2;
}
export function relHead(e, now) {
  if (e.hol) return { c: '', h: e.title };
  const a = numOf(e.ac), f = numOf(e.fc);
  if (e.ac == null) return e.t > now ? { c: '', h: 'Upcoming: ' + e.title } : { c: '', h: 'Released: ' + e.title + ' (no actual yet)' };
  if (isNaN(a) || isNaN(f)) return { c: '', h: e.title + ': ' + e.ac + (e.pv ? ' (previous ' + e.pv + ')' : '') };
  if (a === f) return { c: '', h: e.title + ' came in line with forecast' };
  const up = a > f, w = up ? 'above' : 'below', dir = e.dir;
  if (e.k === 'claims') return up ? { c: 'b', h: 'Bad news: Jobless claims rose more than expected' } : { c: 'g', h: 'Good news: Jobless claims fell more than expected' };
  if (dir === 'inv') return up ? { c: 'b', h: 'Bad news: ' + e.title + ' came in ' + w + ' forecast' } : { c: 'g', h: 'Good news: ' + e.title + ' came in ' + w + ' forecast' };
  if (dir === 'infl') return { c: '', h: (up ? 'Hot: ' : 'Cool: ') + e.title + ' came in ' + w + ' forecast' };
  if (dir === 'grow') return up ? { c: 'g', h: 'Good news: ' + e.title + ' came in ' + w + ' forecast' } : { c: 'b', h: 'Bad news: ' + e.title + ' came in ' + w + ' forecast' };
  return { c: '', h: e.title + ' came in ' + w + ' forecast' };
}
const SCK = ['up', 'eq', 'down'];
export function takeaway(e, fams) {   // one line: which case happened and what it usually means for stocks
  const fam = (fams || {})[e.fam], i = scenIdx(e);
  if (!fam || i < 0) return '';
  return ((fam.lbl || [])[i] || '') + ': ' + fam[SCK[i]].macro + ' Stocks: ' + fam[SCK[i]].stocks;
}
const ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
const p2 = n => String(n).padStart(2, '0');
export const etClock = ms => {
  const p = ETF.formatToParts(new Date(ms)), g = k => p.find(x => x.type === k).value, h = +g('hour'), mi = +g('minute');
  return (h % 12 || 12) + ':' + p2(mi) + ' ' + (h < 12 ? 'AM' : 'PM');
};

// ---- the alert kinds ----
const CUT_REST = 1500;   // the rest of a long post is kept this long (the page keeps all of it)
// what a phone notification shows: the headline on the first line, the rest of the text below it (the banner shows the top lines; long-press opens the rest)
const pbWire = (sp, text) => sp.cut ? String(text || '').trim().slice(0, CUT_REST) : sp.head + (sp.rest ? '\n' + sp.rest.slice(0, CUT_REST) : '');
const tc = x => x.charAt(0) + x.slice(1).toLowerCase();

function wireAlerts(dm, now) {   // Walter Bloomberg: every new post
  const out = [];
  for (const p of dm || []) {
    if (!p || p.t == null || now - p.t > TTL.wire || p.t > now + 60000) continue;
    const sp = wireSplit(p);
    out.push({ id: 'dm:' + p.id, kind: 'wire', t: p.t, src: 'Walter Bloomberg', tag: 'NEW POST', h: sp.head, s: (sp.rest || '').slice(0, CUT_REST), nt: 'Walter Bloomberg', nb: sp.head, pb: pbWire(sp, p.text) });
  }
  return out;
}
function fjAlerts(fj, now) {   // FinancialJuice: only posts marked with the red mark, one alert per story
  const posts = (fj || []).filter(p => p && p.hot === true && p.t != null && now - p.t <= TTL.wire + GROUP_MS * 3 && p.t <= now + 60000).sort((a, b) => b.id - a.id);
  const out = [];
  for (const g of wireGroup(posts, [], now)) {
    const first = g.ps[0];   // the story is as old as its first post: that is when the page would have alerted
    if (now - first.t > TTL.wire) continue;
    const sp = wireSplit(g.p);
    out.push({ id: 'fj:' + first.id, kind: 'fj', t: first.t, n: g.n, src: 'FinancialJuice', tag: g.n > 1 ? 'ALERT · ' + g.n + ' POSTS' : 'ALERT', h: sp.head, s: (sp.rest || '').slice(0, CUT_REST), nt: 'FinancialJuice', nb: sp.head, pb: pbWire(sp, g.p.text) });
  }
  return out;
}
function reminderAlerts(events, now) {   // high-impact USD releases: 15 min and 5 min before, and at the release
  const by = new Map();
  for (const e of events || []) if (e.imp === 3 && e.src !== 'feed') { if (!by.has(e.t)) by.set(e.t, []); by.get(e.t).push(e); }
  const out = [];
  for (const [t, list] of by) for (const r of REM) {
    const at = t - r * 60000;
    if (now < at || now > at + TTL.rem) continue;
    if (r === 0 && list.some(x => x.ac != null)) continue;   // the actual is already in: the release alert carries it, so a "release now" reminder would only contradict it
    const one = list.length === 1 ? list[0] : null, mins = Math.max(1, Math.ceil((t - now) / 60000));
    const tag = 'HIGH IMPACT · ' + (r ? 'RELEASE IN ' + mins + ' MIN' : 'RELEASE NOW'), h = list.map(x => x.title).join(' · ');
    // what the person can use before the number comes out: forecast and previous for every release in the group (up to 4)
    const s = list.slice(0, 4).map(x => (one ? '' : x.title + ': ') + (x.fc ? 'Forecast ' + x.fc : 'No forecast yet') + (x.pv ? ' · previous ' + x.pv : '')).join('\n');
    out.push({ id: 'rem|' + t + '|' + r, kind: 'remind', t: at, src: 'Calendar · USD', tag, h, s, nt: h, nb: (r ? 'Release in ' + mins + ' min' : 'Release at ' + etClock(t) + ' ET') + '\n' + s });
  }
  return out;
}
function releaseAlerts(events, fams, seen, now) {   // actual vs forecast vs previous, one alert per report
  const by = new Map(), out = [];
  for (const e of events || []) {
    if (e.src === 'feed' || e.hol || e.imp !== 3 || e.ac == null || e.t > now + 60000 || e.t < now - TTL.rel) continue;
    const g = e.k + '|' + e.d; if (!by.has(g)) by.set(g, []); by.get(g).push(e);
  }
  for (const [g, list] of by) {
    const f = list[0], t = Math.min(...list.map(x => (seen && seen[x.id]) || x.t));
    const lines = list.slice(0, 4).map(x => x.title + ': ' + x.ac + (x.sr && x.sr.ac === 'FJ' ? ' (FinancialJuice, unconfirmed)' : '') + (x.fc ? ' vs ' + x.fc + ' forecast' : '') + (x.pv ? ' · previous ' + x.pv : '')), tk = takeaway(f, fams), hd = relHead(f, now);
    out.push({ id: 'rel|' + g, kind: 'release', t, src: 'Release · ' + (f.agency || 'USD'), tag: 'RELEASED · ACTUAL VS FORECAST', h: hd.h, s: lines.join('\n') + (tk ? '\n' + tk.slice(0, 280) : ''), nt: hd.h, nb: lines.join('\n') });
  }
  for (const e of events || []) {   // the official number differed from the wire's first figure
    if (!e.wfix || e.ac == null || e.t < now - TTL.fix) continue;
    out.push({ id: 'fix|' + e.id, kind: 'fix', t: Math.max(e.t, (seen && seen[e.id]) || 0), sticky: true, src: 'Release · ' + (e.agency || 'USD'), tag: 'CORRECTED · OFFICIAL FIGURE', h: e.title,
      s: 'The wire showed ' + e.wfix + '. The official figure is ' + e.ac + (e.fc ? ' (forecast ' + e.fc + ')' : '') + '.', nt: 'Corrected: ' + e.title, nb: 'Wire ' + e.wfix + ' → official ' + e.ac });
  }
  return out;
}

// every alert that is alive now, newest first. seen: { eventId: ms the first actual was seen } from the actuals lag log (optional).
// pt, pb: the phone notification's title and body (P8.34 stage 3); the page's own toasts do not use them
const withPush = a => ({ ...a, pt: a.kind === 'remind' ? tc(a.tag) : a.kind === 'fix' ? a.src.replace(/^Release/, 'Corrected') : a.kind === 'fj' && a.n > 1 ? a.src + ' \u00b7 ' + a.n + ' posts' : a.src, pb: a.pb || a.h + (a.s ? '\n' + a.s : '') });
// which parts to build: the wires (D1 posts) and the calendar (events) are fed by different pollers, each of which builds only its own part
export function buildAlerts({ now, dm = [], fj = [], events = [], fams = {}, seen = {}, wire = true, cal = true }) {
  return [...(wire ? [...wireAlerts(dm, now), ...fjAlerts(fj, now)] : []), ...(cal ? [...reminderAlerts(events, now), ...releaseAlerts(events, fams, seen, now)] : [])]
    .map(withPush).sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : 1));
}
// the reminder ids whose moment fell in the last TTL.rem: lets a quiet poller tick ask "is there anything to send?" without building the calendar
export function reminderIdsDue(events, now) {
  const ts = new Set(), out = [];
  for (const e of events || []) if (e && e.imp === 3 && e.src !== 'feed' && Number.isFinite(e.t)) ts.add(e.t);
  for (const t of ts) for (const r of REM) { const at = t - r * 60000; if (now >= at && now <= at + TTL.rem) out.push('rem|' + t + '|' + r); }
  return out;
}
// the test alert behind the page's "send a test" button
export const testAlert = t => withPush({ id: 'test|' + t, kind: 'test', t, src: 'Market Dashboard', tag: 'TEST', h: 'Test alert', s: 'Phone alerts are working. This was sent from the Worker.', nt: 'Test alert', nb: 'Phone alerts are working.' });
// since: only what happened after that moment; a corrected figure (sticky) is always listed, because its moment is the release, not the correction
export const filterAlerts = (list, since) => !since ? list : list.filter(a => a.sticky || a.t > since);
