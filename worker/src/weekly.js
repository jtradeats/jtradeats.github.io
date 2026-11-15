// GET /weekly: week open vs current for NQ, ES, DOW (YM), RTY, GC, CL (plan P5, D85).
// Week open = the open of the first 15-minute bar at or after the Sunday Globex reopen (18:00 New York, DST handled by the
// zone), always Sunday onwards. Between Friday's close and the Sunday reopen the same rule still points at the week that just
// ended, so the card shows that week's final state and the page dims it and tags it CLOSED.
// The six items live in worker/config/symbols.json ("set": "weekly") with their reopen time, zone and first-bar jump limit; index.js passes the list in.
// One Yahoo chart call per symbol (10 days of 15-minute bars): 6 subrequests, 12 if every first host fails.
import { chart, quote, makeRoute } from './route.js';

const BASE_KEY = 'weekly:contracts';
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// ---- time in a named zone (no library): wall-clock parts of an instant, and the instant of a wall-clock time ----
function parts(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const g = k => p.find(x => x.type === k).value;
  return { y: +g('year'), mo: +g('month'), d: +g('day'), dow: DOW[g('weekday')], h: +g('hour'), mi: +g('minute') };
}
function zonedMs(y, mo, d, h, mi, tz) {
  const asUTC = Date.UTC(y, mo - 1, d, h, mi);
  const q = parts(asUTC, tz), seen = Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi);
  return asUTC - (seen - asUTC);
}
// The most recent Sunday <hh:mm> (zone time) that is not after `now`, minus `weeksBack` weeks.
export function lastReopen(now, tz, hhmm, weeksBack = 0) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const p = parts(now, tz);
  const at = dayMs => { const x = new Date(dayMs); return zonedMs(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), hh, mm, tz); };
  let day = Date.UTC(p.y, p.mo - 1, p.d - p.dow);               // that zone's calendar date of the latest Sunday (today if Sunday)
  if (at(day) > now) day -= 7 * 864e5;                           // it is Sunday but before the reopen: the week still running began a week earlier
  return at(day - weeksBack * 7 * 864e5);
}

function firstBar(ts, O, ro) {
  for (let i = 0; i < ts.length; i++) if (ts[i] * 1000 >= ro && Number.isFinite(O[i])) return i;
  return -1;
}

async function fetchOne(spec) {
  const hop = spec.chain.find(h => h[0] === 'yahoo');
  if (!hop) throw new Error('no yahoo entry in chain');
  const sym = hop[1];
  const r = await chart(sym, '10d', '15m');                      // 10 days, not 7: the Sunday-evening fallback to last week needs the older reopen
  const ts = r.timestamp || [], q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const O = q.open || [], H = q.high || [], L = q.low || [], Cl = q.close || [];
  const now = Date.now();

  let ro = lastReopen(now, spec.tz, spec.reopen, 0), bar = firstBar(ts, O, ro);
  if (bar < 0) { ro = lastReopen(now, spec.tz, spec.reopen, 1); bar = firstBar(ts, O, ro); }   // new week not in the data yet: show the week that just ended
  if (bar < 0) throw new Error('no bars since the Sunday reopen');

  let hi = -Infinity, lo = Infinity, last = -1;
  for (let i = bar; i < ts.length; i++) {
    if (Number.isFinite(H[i]) && H[i] > hi) hi = H[i];
    if (Number.isFinite(L[i]) && L[i] < lo) lo = L[i];
    if (Number.isFinite(Cl[i])) last = i;
  }
  const open = +Number(O[bar]).toFixed(4), eps = Math.abs(open) * 1e-6;

  // current = the latest trade Yahoo reports (what the tape tile shows); the last bar close only if that is missing
  const m = r.meta;
  let p, t;
  if (Number.isFinite(m.regularMarketPrice) && m.regularMarketTime) { p = m.regularMarketPrice; t = m.regularMarketTime * 1000; }
  else if (last >= 0) { p = Cl[last]; t = ts[last] * 1000; }
  if (!Number.isFinite(p)) throw new Error('no current price');

  // validation (plan P5): the open must sit inside its own bar and inside the week's range, and the first bar must not have
  // moved more than the symbol's limit. A failure is shown as a flag on the tile, never hidden and never "fixed".
  const flags = [];
  if (Number.isFinite(H[bar]) && Number.isFinite(L[bar]) && (open > H[bar] + eps || open < L[bar] - eps)) flags.push('open is outside its own bar');
  if (Number.isFinite(hi) && Number.isFinite(lo) && (open > hi + eps || open < lo - eps)) flags.push('open is outside the week range');
  if (spec.jump && Number.isFinite(Cl[bar]) && Math.abs(Cl[bar] - open) / open * 100 > spec.jump) flags.push(`first bar moved more than ${spec.jump}%`);

  const name = m.shortName || m.longName;
  const out = { src: `yahoo:${sym}`, f: Date.now(), open, ot: ts[bar] * 1000, ro, n: ts.length - bar, ...quote(p, open, t) };
  if (name) out.contract = String(name).slice(0, 60);
  if (flags.length) out.flag = flags.join('; ');
  if (out.ot - ro > 30 * 60000) out.late = true;                  // reopened late (holiday week, or Yahoo is missing early bars): the tooltip says so
  return out;
}

// ---- contract baseline per week (R54): what each future was called the first time this week's open was read ----
// If the name later differs, or /market saw a roll after the reopen, the week's open and current are different contracts,
// so the tile shows "n/a, contract changed" instead of a wrong number. KV: one small key, written only when something is
// added (about 6 writes in a week), the newest two weeks kept.
const merge = (a, b) => {   // a wins on conflicts
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = (a || {})[k] || {}, y = (b || {})[k] || {};
    out[k] = { c: { ...y.c, ...x.c }, r: { ...y.r, ...x.r } };
  }
  return out;
};
const prune = rec => Object.fromEntries(Object.keys(rec).sort().slice(-2).map(k => [k, rec[k]]));   // keys are 13-digit epoch ms, so text order is time order

// marketRoll(tapeLabel) -> epoch ms when /market last saw that future's contract change (it keeps that for 24 h), or null
export function makeWeekly({ items, marketRoll } = {}) {
  const SPECS = items.filter(i => i.set === 'weekly');
  const SPEC_BY = Object.fromEntries(SPECS.map(x => [x.label, x]));
  let base = null, baseAt = 0;   // this week's contract names, per instance: KV is the shared copy
  async function loadBase(env) {
    if (base && Date.now() - baseAt < 10 * 60000) return base;
    let rec = base || {};
    if (env && env.MARKET_KV) { try { const j = await env.MARKET_KV.get(BASE_KEY, 'json'); if (j && typeof j === 'object') rec = merge(j, rec); } catch (e) { /* carry on in memory */ } }
    base = rec; baseAt = Date.now();
    return base;
  }
  async function saveBase(env, rec) {
    base = prune(rec); baseAt = Date.now();
    if (!(env && env.MARKET_KV)) return;
    try {
      const cur = await env.MARKET_KV.get(BASE_KEY, 'json');       // another isolate may have written since: its entries win, ours fill the gaps
      base = prune(merge(cur || {}, base));
      await env.MARKET_KV.put(BASE_KEY, JSON.stringify(base));
    } catch (e) { /* ignore: a failed write never reaches the page */ }
  }
  async function finish(items, env, now, notes) {
    const rec = await loadBase(env);
    let dirty = false;
    const out = items.map(it => {
      if (it.p == null || !it.contract || it.ro == null) return it;
      const wk = rec[String(it.ro)] || (rec[String(it.ro)] = { c: {}, r: {} });
      if (!(it.label in wk.c)) { wk.c[it.label] = it.contract; dirty = true; }
      if (!wk.r[it.label]) {
        const tape = SPEC_BY[it.label] && SPEC_BY[it.label].roll, mr = marketRoll && tape ? marketRoll(tape) : null;
        if (wk.c[it.label] !== it.contract) { wk.r[it.label] = now; dirty = true; notes.push(`${it.label} contract changed this week: ${wk.c[it.label]} -> ${it.contract}`); }
        else if (mr && mr >= it.ro) { wk.r[it.label] = mr; dirty = true; notes.push(`${it.label} contract rolled after the reopen (seen on the tape)`); }
      }
      return wk.r[it.label] ? { ...it, rolled: true, was: wk.c[it.label], open: null, c: null, pc: null } : it;
    });
    if (dirty) await saveBase(env, rec);
    const ros = out.map(i => i.ro).filter(Number.isFinite);
    return { items: out, extra: ros.length ? { reopen: Math.max(...ros) } : {} };
  }
  return makeRoute({ name: 'weekly', kvKey: 'weekly:snapshot', specs: SPECS, fetchOne, finish });
}
