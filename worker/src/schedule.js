// Official release schedule: expand schedule.json into events, audit it, and cross-check it against the optional feed.
// Pure functions: no fetch, no globals, so the Worker and the tests use the same code.
// All dates and times in schedule.json are New York wall-clock; everything returned is epoch ms.

const NY = 'America/New_York';
const NYF = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY = 864e5;

// ---- New York time by date arithmetic (plan P8.15, D112) ----
// The US rule in force since 2007: daylight time runs from the second Sunday of March, 02:00 local standard time (07:00 UTC),
// to the first Sunday of November, 02:00 local daylight time (06:00 UTC). No Intl call: the Intl version below (etPartsIntl) stays
// only as the test oracle. Each year's two boundaries are worked out once and kept.
const DST_YEARS = new Map();
function dstSpan(y) {
  let s = DST_YEARS.get(y);
  if (!s) {
    const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay(), nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    s = [Date.UTC(y, 2, 1 + ((7 - mar1) % 7) + 7, 7), Date.UTC(y, 10, 1 + ((7 - nov1) % 7), 6)];
    DST_YEARS.set(y, s);
  }
  return s;
}
// wall clock minus UTC at the instant t, in ms (-4 h in daylight time, -5 h otherwise)
function nyOffset(t) {
  const [a, b] = dstSpan(new Date(t).getUTCFullYear());
  return t >= a && t < b ? -4 * 36e5 : -5 * 36e5;
}
const p2 = n => (n < 10 ? '0' : '') + n;

// New York wall-clock parts of an instant
export function etParts(ms) {
  const x = new Date(ms + nyOffset(ms)), y = x.getUTCFullYear(), mo = x.getUTCMonth() + 1, d = x.getUTCDate(), h = x.getUTCHours(), mi = x.getUTCMinutes();
  return { y, mo, d, h, mi, s: x.getUTCSeconds(), dow: x.getUTCDay(),
    iso: `${y}-${p2(mo)}-${p2(d)}`, hm: `${p2(h)}:${p2(mi)}` };
}
// the Intl version (what etParts was until P8.15): kept for the tests only
export function etPartsIntl(ms) {
  const p = NYF.formatToParts(new Date(ms)), g = k => p.find(x => x.type === k).value;
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour'), mi: +g('minute'), s: +g('second'), dow: DOW.indexOf(g('weekday')),
    iso: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
}

// 'YYYY-MM-DDTHH:MM[:SS]' written as New York wall-clock time -> epoch ms (null if it doesn't parse). Two passes so DST edges are right
// (the same two passes as before, so the gap and overlap hours give the same answers as the Intl version).
export function etToMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(String(s || ''));
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = asUTC - nyOffset(asUTC);
  t = asUTC - nyOffset(t);
  return t;
}

const isoOf = dt => dt.toISOString().slice(0, 10);
const dowOf = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
const addDays = (iso, n) => isoOf(new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY));
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

function nthDow(y, m, dow, n) {   // m 1..12; n = 1.. or -1 for the last
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return isoOf(new Date(Date.UTC(y, m - 1, 1 + ((dow - first + 7) % 7) + (n - 1) * 7)));
  }
  const last = new Date(Date.UTC(y, m, 0)), diff = (last.getUTCDay() - dow + 7) % 7;
  return isoOf(new Date(+last - diff * DAY));
}

// US federal holidays as observed (a Saturday holiday is observed on Friday, a Sunday holiday on Monday): iso -> name
export function holidays(y) {
  const out = new Map();
  const fixed = (m, d, name) => {
    const dt = new Date(Date.UTC(y, m - 1, d)), w = dt.getUTCDay();
    out.set(isoOf(w === 6 ? new Date(+dt - DAY) : w === 0 ? new Date(+dt + DAY) : dt), name);
  };
  fixed(1, 1, 'New Year'); fixed(6, 19, 'Juneteenth'); fixed(7, 4, 'Independence Day'); fixed(11, 11, 'Veterans Day'); fixed(12, 25, 'Christmas');
  out.set(nthDow(y, 1, 1, 3), 'Martin Luther King Jr. Day');
  out.set(nthDow(y, 2, 1, 3), "Presidents' Day");
  out.set(nthDow(y, 5, 1, -1), 'Memorial Day');
  out.set(nthDow(y, 9, 1, 1), 'Labor Day');
  out.set(nthDow(y, 10, 1, 2), 'Columbus Day');
  out.set(nthDow(y, 11, 4, 4), 'Thanksgiving');
  return out;
}
function holidaySet(from, to) {
  const m = new Map();
  for (let y = +from.slice(0, 4) - 1; y <= +to.slice(0, 4) + 1; y++) for (const [k, v] of holidays(y)) m.set(k, v);
  return m;
}

// Schedule lines -> events (one per row of the kind), sorted. Lines with an unknown kind or a bad date/time are skipped here and reported by audit().
// A line for the jobs report expands into payrolls, unemployment and earnings; a rate decision into decision, statement and press conference.
export function expand(SCHED, IND) {
  const out = [], order = Object.keys(IND.kinds);
  (SCHED.releases || []).forEach((r, li) => {
    const ind = IND.kinds[r.k], t0 = etToMs(`${r.d}T${r.t}`);
    if (!ind || t0 == null) return;
    (ind.rows || [{ id: 'main', t: ind.name, u: '' }]).forEach((row, ri) => {
      const title = r.ti || (row.t + (ind.np || !r.p ? '' : (/^Q\d$/.test(r.p) ? ' (' + r.p + ')' : ' (' + r.p + ')')));
      out.push({
        id: `${r.k}|${r.d}|${row.id}`, t: t0 + (row.off || 0) * 60000, k: r.k, r: row.id, title, imp: r.i ?? row.imp ?? ind.imp, agency: ind.agency,
        v: r.v || 'official', n: r.n || null, pd: r.p || null, d: r.d, src: 'schedule', fc: null, pv: null, ac: null,
        u: row.u || '', dir: row.dir || ind.dir || 'none', fam: row.fam || ind.fam || null, ic: row.ic || null,
        pre: r.pre ? 1 : 0, ad: r.ad || 0, hol: ind.hol ? 1 : 0, _o: order.indexOf(r.k) * 100 + ri, _l: li,
      });
    });
  });
  out.sort((a, b) => a.t - b.t || a._o - b._o || a._l - b._l);
  for (const e of out) { delete e._o; delete e._l; }
  return out;
}

// ---- audit: is the schedule file itself plausible, fresh and consistent? ----
export function audit(SCHED, IND, nowMs) {
  const issues = [], add = (lvl, code, msg, extra) => issues.push({ lvl, code, msg, ...extra });
  const rel = SCHED.releases || [];
  const today = etParts(nowMs).iso;
  const first = rel.reduce((m, r) => (r.d < m ? r.d : m), '9999'), last = rel.reduce((m, r) => (r.d > m ? r.d : m), '0000');
  const hol = holidaySet(first === '9999' ? today : first, last === '0000' ? today : last);
  const seen = new Set(), byKind = {};

  // 1. clock/time-zone self-test: the conversion everything depends on
  const T = [['2027-01-08T08:30', Date.UTC(2027, 0, 8, 13, 30)], ['2027-07-02T08:30', Date.UTC(2027, 6, 2, 12, 30)],
    ['2026-12-09T14:00', Date.UTC(2026, 11, 9, 19, 0)], ['2027-03-17T14:00', Date.UTC(2027, 2, 17, 18, 0)]];
  const badTz = T.filter(([s, want]) => etToMs(s) !== want);
  if (badTz.length) add('error', 'tz', `Time-zone self-test failed for ${badTz.map(x => x[0]).join(', ')}: this runtime converts New York time wrongly, so every countdown is off.`);

  // 2. line by line
  for (const r of rel) {
    const ind = IND.kinds[r.k], id = `${r.k} ${r.d}`;
    if (!ind) { add('error', 'kind', `${id}: unknown kind "${r.k}" (add it to indicators.json).`, { k: r.k, d: r.d }); continue; }
    if (!/^\d{4}-\d\d-\d\d$/.test(r.d || '') || isNaN(Date.parse(r.d + 'T00:00:00Z')) || etToMs(`${r.d}T${r.t}`) == null) {
      add('error', 'format', `${id}: date or time is not valid (${r.d} ${r.t}).`, { k: r.k, d: r.d }); continue;
    }
    const key = `${r.k}|${r.d}|${r.t}|${r.p || ''}`;
    if (seen.has(key)) add('error', 'dup', `${id}: listed twice.`, { k: r.k, d: r.d });
    seen.add(key);
    (byKind[r.k] = byKind[r.k] || []).push(r);
    const w = dowOf(r.d);
    if (!ind.free) {   // speeches, holidays and strategy meetings have no fixed time or weekday pattern
      if (w === 0 || w === 6) add('error', 'weekend', `${id} falls on a ${DOW[w]}.`, { k: r.k, d: r.d });
      if (hol.has(r.d)) add('error', 'holiday', `${id} falls on a federal holiday (${hol.get(r.d)}).`, { k: r.k, d: r.d });
      const okTimes = [ind.time].concat(ind.alt || []);
      if (!okTimes.includes(r.t)) add('error', 'time', `${id}: time is ${r.t} ET but ${r.k} normally releases at ${ind.time} ET.`, { k: r.k, d: r.d });
      if (ind.dow && !ind.dow.includes(w)) add('warn', 'dow', `${id} is a ${DOW[w]}; ${r.k} is normally ${ind.dow.map(x => DOW[x]).join(' or ')}.`, { k: r.k, d: r.d });
      if (r.k === 'claims' && w !== 4 && !hol.has(addDays(r.d, 1))) add('warn', 'claims_day', `${id}: claims are released on Thursday unless Thursday is a federal holiday.`, { k: r.k, d: r.d });
    }
    if (r.v === 'check') add('warn', 'unconfirmed', `${id}: ${r.n || 'marked as doubtful in schedule.json.'}`, { k: r.k, d: r.d });
    else if (r.v === 'rule' && r.d >= today && daysBetween(today, r.d) <= 14) add('warn', 'rule_soon', `${id} is only derived from the agency's usual pattern and is within 14 days. Confirm it on the agency's page.`, { k: r.k, d: r.d });
  }

  // 3. cadence per kind
  const monthKey = d => d.slice(0, 7);
  const weekKey = d => addDays(d, -((dowOf(d) + 6) % 7));
  for (const [k, list] of Object.entries(byKind)) {
    const per = IND.kinds[k].per, ds = list.map(r => r.d).sort();
    if (per === 'm') {
      // One release per reference period, not per calendar month of the release date: JOLTS for February comes out on 30 March and the one for
      // March on 5 May, so counting release months reported a gap in April that is not one. Lines with a period ("Feb") are counted by that period
      // (the same reading as refYM in schedule_sync.js); a kind where any line lacks one is counted by release month as before.
      const refMon = (p, d) => {
        const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(p || '').slice(0, 3).toLowerCase());
        if (mi < 0) return null;
        const [y, mo] = d.split('-').map(Number);
        return `${mi + 1 > mo ? y - 1 : y}-${String(mi + 1).padStart(2, '0')}`;
      };
      const refs = list.map(r => refMon(r.p, r.d)), byRef = refs.every(Boolean);
      const keys = (byRef ? refs : ds.map(monthKey)).slice().sort();
      const months = {};
      keys.forEach(key => { months[key] = (months[key] || 0) + 1; });
      let [y, m] = keys[0].split('-').map(Number);
      const [ly, lm] = keys[keys.length - 1].split('-').map(Number);
      while (y < ly || (y === ly && m <= lm)) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        if (!months[key]) add('error', 'gap', `${k}: no release listed in ${key}.`, { k });
        else if (months[key] > 1) add('error', 'extra', `${k}: ${months[key]} releases listed in ${key}; expected one.`, { k });
        if (++m > 12) { m = 1; y++; }
      }
    } else if (per === 'w') {
      const weeks = {};
      ds.forEach(d => { weeks[weekKey(d)] = (weeks[weekKey(d)] || 0) + 1; });
      for (let wk = weekKey(ds[0]); wk <= weekKey(ds[ds.length - 1]); wk = addDays(wk, 7)) {
        if (!weeks[wk]) add('error', 'gap', `${k}: no release in the week of ${wk}.`, { k });
        else if (weeks[wk] > 1) add('error', 'extra', `${k}: ${weeks[wk]} releases in the week of ${wk}.`, { k });
      }
    } else if (per === 'q8' && k === 'fomc') {
      for (let i = 1; i < ds.length; i++) {
        const g = daysBetween(ds[i - 1], ds[i]);
        if (g < 28 || g > 90) add('warn', 'fomc_gap', `fomc: ${ds[i - 1]} to ${ds[i]} is only ${g} days. Meetings are normally 6 to 8 weeks apart. Re-check against the Fed calendar.`, { k, d: ds[i] });
      }
      const perYear = {};
      ds.forEach(d => { perYear[d.slice(0, 4)] = (perYear[d.slice(0, 4)] || 0) + 1; });
      for (const [y, n] of Object.entries(perYear)) if (n > 8) add('warn', 'fomc_count', `fomc: ${n} meetings listed in ${y}; the Fed holds eight.`, { k });
    }
  }
  // minutes follow the decision by three weeks
  const fomcDays = new Set((byKind.fomc || []).concat(byKind.fomc_s || []).map(r => r.d));
  for (const r of byKind.minutes || []) {
    const dec = addDays(r.d, -21);
    if (!fomcDays.has(dec) && dec >= first) add('warn', 'minutes', `minutes ${r.d}: no FOMC decision listed on ${dec}, three weeks earlier.`, { k: 'minutes', d: r.d });
  }

  // 4. freshness and horizon per kind
  for (const k of Object.keys(IND.kinds)) {
    const list = byKind[k] || [], checked = (SCHED.checked || {})[k];
    if (!list.length) { if (!IND.kinds[k].free) add('error', 'empty', `${k}: nothing in schedule.json.`, { k }); continue; }
    const ahead = list.filter(r => r.d >= today).map(r => r.d).sort();
    if (!ahead.length) { if (!IND.kinds[k].free) add('error', 'ended', `${k}: no future release left in schedule.json. Refresh the file.`, { k }); }
    else if (!IND.kinds[k].free && daysBetween(today, ahead[ahead.length - 1]) < (IND.kinds[k].hz || 45)) add('warn', 'horizon', `${k}: schedule runs out on ${ahead[ahead.length - 1]}. Refresh the file soon.`, { k });
    if (!checked) add('warn', 'unchecked', `${k}: no "checked" date, so nobody has confirmed it against the agency page.`, { k });
    else {
      const age = daysBetween(checked, today);
      if (age > 365) add('error', 'stale', `${k}: last checked ${checked} (${age} days ago).`, { k });
      else if (age > 120) add('warn', 'stale', `${k}: last checked ${checked} (${age} days ago). Agencies publish changes; re-check.`, { k });
    }
  }

  const counts = { official: 0, ref: 0, rule: 0, check: 0, tent: 0, prov: 0 };   // tent = tentative date published by the agency (Treasury); prov = date from a calendar provider
  rel.forEach(r => { counts[r.v === 'rule' ? 'rule' : r.v === 'check' ? 'check' : r.v === 'ref' ? 'ref' : r.v === 'tent' ? 'tent' : r.v === 'prov' ? 'prov' : 'official']++; });
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.lvl] - order[b.lvl]);
  const status = issues.some(i => i.lvl === 'error') ? 'error' : issues.some(i => i.lvl === 'warn') ? 'check' : 'ok';
  const checkedDates = Object.values(SCHED.checked || {}).sort();
  return { status, issues: issues.slice(0, 40), nIssues: issues.length, counts, total: rel.length, first, horizon: last,
    checked: checkedDates[0] || null, checkedNewest: checkedDates[checkedDates.length - 1] || null };
}

// ---- optional providers: forecast, previous and (where the provider has them) actual values, plus an independent check on dates and times ----
// Providers are unofficial or licensed third parties. Their rows are normalised to { t, title, imp, fc, pv, ac } and tied to a schedule row by title.
const RXC = new WeakMap();
function rowRx(IND) {
  let c = RXC.get(IND);
  if (!c) {
    c = [];
    for (const [k, ind] of Object.entries(IND.kinds)) for (const row of ind.rows || []) for (const m of row.match || []) c.push({ k, r: row.id, rx: new RegExp(m, 'i') });
    RXC.set(IND, c);
  }
  return c;
}
const CANDC = new WeakMap();   // IND -> Map(title -> candidates): the same provider titles come back on every rebuild
export function candidates(IND, title) {
  let m = CANDC.get(IND);
  if (!m) { m = new Map(); CANDC.set(IND, m); }
  let c = m.get(title);
  if (!c) {
    c = rowRx(IND).filter(x => x.rx.test(title)).map(x => ({ k: x.k, r: x.r }));
    if (m.size > 500) m.clear();
    m.set(title, c);
  }
  return c;   // callers only read it
}

// Fair Economy / Forex Factory weekly JSON (no key, no actuals, rate-limits shared Cloudflare IPs)
// IND (optional, indicators.json): a "Low" row is kept when its title matches a row of a release the dashboard shows. Forex Factory rates Crude Oil Inventories "Low",
// so without this its forecast never arrived (P8.33). Everything else rated Low is still dropped. imp 1 = Low (never drives a countdown or an "extras" line).
export function normFair(rows, IND) {
  const out = [];
  for (const r of rows || []) {
    const t = Date.parse(r.date);
    if (r.country !== 'USD' || !t) continue;
    const title = String(r.title).slice(0, 80);
    const imp = r.impact === 'High' ? 3 : r.impact === 'Medium' ? 2 : r.impact === 'Low' && IND && candidates(IND, title).length ? 1 : 0;
    if (!imp) continue;
    out.push({ t, title, imp, fc: r.forecast || null, pv: r.previous || null, ac: r.actual || null });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Financial Modeling Prep /stable/economic-calendar (free key). Documented fields: date (UTC, "YYYY-MM-DD HH:MM:SS"), country, event, previous, estimate, actual, impact, unit.
// The mapping is tolerant of other common names so that a similar provider can be swapped in; check /calendar?debug=1 after connecting.
export function normFmp(rows) {
  const out = [];
  const num = v => (v === null || v === undefined || v === '' ? null : v);
  for (const r of Array.isArray(rows) ? rows : []) {
    const c = String(r.country || '').toUpperCase();
    if (c && c !== 'US' && c !== 'USD') continue;
    const ds = String(r.date || r.datetime || '');
    const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(ds) ? ds.replace(' ', 'T') : ds.replace(' ', 'T') + 'Z');
    const title = String(r.event || r.title || r.name || '').slice(0, 80);
    if (!Number.isFinite(t) || !title) continue;
    const im = String(r.impact ?? r.importance ?? '').toLowerCase();
    out.push({ t, title, imp: im === 'high' || im === '3' ? 3 : im === 'medium' || im === '2' ? 2 : 1,
      fc: num(r.estimate ?? r.forecast ?? r.consensus), pv: num(r.previous), ac: num(r.actual), unit: r.unit || null });
  }
  return out.sort((a, b) => a.t - b.t);
}

const trim = (x, dp) => String(+x.toFixed(dp));
// a provider number -> the text the calendar shows ("0.4%", "189K", "-0.865M"), using the row's unit
export function fmtVal(v, u) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v.trim() || null;
  if (!Number.isFinite(v)) return null;
  if (u === '%') return trim(v, 3) + '%';
  if (u === 'K') return (Math.abs(v) >= 10000 ? trim(v / 1000, 1) : trim(v, 1)) + 'K';
  if (u === 'M') return (Math.abs(v) >= 100000 ? trim(v / 1e6, 3) : trim(v, 3)) + 'M';
  return trim(v, 3);
}

// feeds: [{ name, rows }] lowest priority first (a later feed overwrites a field only when it has a value).
// events: schedule events inside the window. Returns { events, issues, matched, extras, unmatched }. Never throws on odd rows.
export function overlay(events, feeds, IND, nowMs) {
  const evs = events.map(e => ({ ...e })), issues = [], unmatched = [];
  const today = etParts(nowMs).iso, lim = addDays(today, 21);
  const byId = new Map(evs.map(e => [e.id, e]));
  const extras = [], hit = new Set(), seenX = new Set();
  for (const feed of feeds || []) {
    for (const row of feed.rows || []) {
      if (!row || !Number.isFinite(row.t)) continue;
      const p = etParts(row.t), title = row.title || '', cands = candidates(IND, title);
      const c = cands.find(x => byId.has(`${x.k}|${p.iso}|${x.r}`));
      if (!c) {
        if (cands.length) {
          // the provider has this release on a day the schedule does not: either the schedule moved or the provider is wrong
          if (p.iso >= today && p.iso <= lim && row.imp === 3 && !seenX.has('d' + title + p.iso)) {
            seenX.add('d' + title + p.iso);
            const near = evs.find(e => e.k === cands[0].k && e.t >= nowMs - DAY && Math.abs(daysBetween(e.d, p.iso)) <= 3);
            issues.push({ lvl: 'warn', code: 'feed_date', k: cands[0].k, d: p.iso,
              msg: `${feed.name} lists "${title}" on ${p.iso} ${p.hm} ET${near ? `, schedule has ${near.d} ${near.title}` : ', schedule has nothing near that date'}. One of them is wrong: check the agency page.` });
            if (near) near.flag = `${feed.name} says ${p.iso} ${p.hm} ET`;
          }
        } else {
          if (row.imp === 3) unmatched.push(title);
          if (p.iso >= today && p.iso <= lim && row.imp === 3 && row.t > nowMs - 36e5 && !seenX.has('x' + title + row.t)) {
            seenX.add('x' + title + row.t);
            extras.push({ id: `feed|${row.t}|${title}`, t: row.t, k: 'feed', r: 'x', title, imp: 3, agency: null, v: 'feed', pd: null, d: p.iso, src: 'feed', u: '', dir: 'none', fam: null, ic: null, pre: 0, ad: 0, hol: 0,
              n: `Only in ${feed.name}. Not part of the official schedule, so it does not drive the countdown.`, fc: fmtVal(row.fc, ''), pv: fmtVal(row.pv, ''), ac: fmtVal(row.ac, '') });
          }
        }
        continue;
      }
      const ev = byId.get(`${c.k}|${p.iso}|${c.r}`);
      hit.add(ev.id);
      for (const f of ['fc', 'pv', 'ac']) {
        let v = fmtVal(row[f], ev.u);
        // a row may ask for fixed decimals on a forecast (indicators.json "dp"): Forex Factory writes crude as 0.4M, the reference calendar as 0.400M
        if (v !== null && f === 'fc' && ev.u === 'M') { const dp = (IND.kinds[ev.k].rows.find(x => x.id === ev.r) || {}).dp; if (dp != null && /^-?\d+(\.\d+)?M$/.test(v)) v = parseFloat(v).toFixed(dp) + 'M'; }
        // Forex Factory rounds crude to 0.1M (3.4M) where the release itself has three decimals (3.380M). A previous that is already held, and that the feed's figure is only a rounding of,
        // keeps its three decimals; a previous that differs by more than the rounding (a revision) is still taken from the feed.
        if (v !== null && f === 'pv' && ev.u === 'M' && ev.pv != null && (IND.kinds[ev.k].rows.find(x => x.id === ev.r) || {}).dp != null
          && /^-?\d+(\.\d+)?M$/.test(v) && /^-?\d+(\.\d+)?M$/.test(String(ev.pv)) && Math.abs(parseFloat(ev.pv) - parseFloat(v)) <= 0.0501) continue;
        if (v !== null) { ev[f] = v; (ev.sr = ev.sr || {})[f] = feed.name; }
      }
      const dt = Math.round((row.t - ev.t) / 60000);
      if (dt !== 0 && Math.abs(dt) < 24 * 60 && !ev.ad && !(IND.kinds[ev.k].rows.find(x => x.id === ev.r) || {}).off) {
        ev.flag = `${feed.name} says ${p.hm} ET, schedule says ${etParts(ev.t).hm} ET`;
        issues.push({ lvl: 'warn', code: 'feed_time', k: ev.k, d: ev.d, msg: `${ev.title} on ${ev.d}: ${feed.name} says ${p.hm} ET but the schedule says ${etParts(ev.t).hm} ET. Check the agency page.` });
      }
    }
  }
  return { events: evs.concat(extras).sort((a, b) => a.t - b.t), issues, matched: hit.size, extras: extras.length, unmatched: [...new Set(unmatched)].slice(0, 20) };
}

// Hand-typed numbers (worker/config/results.json) are PLACEHOLDERS: they fill a field only when no real source has supplied it, and are tagged sr = 'ref'.
// Every later layer (the wire, the official FRED series) treats a 'ref' field as blank and replaces it, and a provider number has already replaced it by the time this runs.
// The revision mark (pvc) belongs to a typed previous, so it is kept only while that typed previous is the one showing.
export function applyResults(events, RES) {
  const rows = (RES && RES.rows) || {};
  let n = 0;
  for (const e of events) {
    const x = rows[e.id];
    if (!x) continue;
    n++;
    for (const f of ['fc', 'pv', 'ac']) if (x[f] != null && x[f] !== '' && (e[f] == null || e[f] === '')) { e[f] = x[f]; (e.sr = e.sr || {})[f] = 'ref'; }
    if (x.pvc && e.sr && e.sr.pv === 'ref') e.pvc = x.pvc;
  }
  return n;
}

// Typed numbers a real source has replaced with a different value: [{ id, f, typed, now, src }]. For /calendar?debug=1: these lines can be deleted from results.json.
export function typedReplaced(events, RES) {
  const rows = (RES && RES.rows) || {}, out = [];
  for (const e of events) {
    const x = rows[e.id];
    if (!x) continue;
    for (const f of ['fc', 'pv', 'ac']) {
      if (x[f] == null || x[f] === '' || (e.sr && e.sr[f] === 'ref')) continue;
      if (e[f] != null && String(e[f]) !== String(x[f])) out.push({ id: e.id, f, typed: x[f], now: e[f], src: (e.sr && e.sr[f]) || null });
    }
  }
  return out;
}

// "previous" with nothing better: the actual of the release before it (not revised, so labelled as carried over)
export function chainPrevious(events) {
  const last = new Map();
  for (const e of events) {
    if (e.hol || e.src === 'feed') continue;
    const key = e.k + '|' + e.r, prev = last.get(key);
    if (e.pv == null && prev && prev.ac != null) { e.pv = prev.ac; (e.sr = e.sr || {}).pv = 'last release'; }
    last.set(key, e);
  }
}