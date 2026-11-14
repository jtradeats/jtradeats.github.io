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

// New York wall-clock parts of an instant
export function etParts(ms) {
  const p = NYF.formatToParts(new Date(ms)), g = k => p.find(x => x.type === k).value;
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour'), mi: +g('minute'), s: +g('second'), dow: DOW.indexOf(g('weekday')),
    iso: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
}

// 'YYYY-MM-DDTHH:MM[:SS]' written as New York wall-clock time -> epoch ms (null if it doesn't parse). Two passes so DST edges are right.
export function etToMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(String(s || ''));
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const off = t => { const q = etParts(t); return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - t; };   // wall clock minus UTC at instant t
  let t = asUTC - off(asUTC);
  t = asUTC - off(t);
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

const eventTitle = (ind, r) => {
  const p = r.p ? (/^Q\d/.test(r.p) ? ' ' + r.p : ' (' + r.p + ')') : '';
  return (ind ? ind.name : r.k) + p;
};

// Schedule lines -> events, sorted. Lines with an unknown kind or a bad date/time are skipped here and reported by audit().
export function expand(SCHED, IND) {
  const out = [];
  for (const r of SCHED.releases || []) {
    const ind = IND.kinds[r.k], t = etToMs(`${r.d}T${r.t}`);
    if (!ind || t == null) continue;
    out.push({
      t, k: r.k, title: eventTitle(ind, r), imp: r.i || ind.imp, agency: ind.agency,
      v: r.v || 'official', n: r.n || null, pd: r.p || null, d: r.d, src: 'schedule',
      fc: null, pv: null, ac: null,
    });
  }
  out.sort((a, b) => a.t - b.t || a.title.localeCompare(b.title));
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
    if (w === 0 || w === 6) add('error', 'weekend', `${id} falls on a ${DOW[w]}.`, { k: r.k, d: r.d });
    if (hol.has(r.d)) add('error', 'holiday', `${id} falls on a federal holiday (${hol.get(r.d)}).`, { k: r.k, d: r.d });
    if (r.t !== ind.time) add('error', 'time', `${id}: time is ${r.t} ET but ${r.k} normally releases at ${ind.time} ET.`, { k: r.k, d: r.d });
    if (ind.dow && !ind.dow.includes(w)) add('warn', 'dow', `${id} is a ${DOW[w]}; ${r.k} is normally ${ind.dow.map(x => DOW[x]).join(' or ')}.`, { k: r.k, d: r.d });
    if (r.k === 'claims' && w !== 4 && !hol.has(addDays(r.d, 1))) add('warn', 'claims_day', `${id}: claims are released on Thursday unless Thursday is a federal holiday.`, { k: r.k, d: r.d });
    if (r.v === 'check') add('warn', 'unconfirmed', `${id}: ${r.n || 'marked as doubtful in schedule.json.'}`, { k: r.k, d: r.d });
    else if (r.v === 'rule' && r.d >= today && daysBetween(today, r.d) <= 14) add('warn', 'rule_soon', `${id} is only derived from the agency's usual pattern and is within 14 days. Confirm it on the agency's page.`, { k: r.k, d: r.d });
  }

  // 3. cadence per kind
  const monthKey = d => d.slice(0, 7);
  const weekKey = d => addDays(d, -((dowOf(d) + 6) % 7));
  for (const [k, list] of Object.entries(byKind)) {
    const per = IND.kinds[k].per, ds = list.map(r => r.d).sort();
    if (per === 'm') {
      const months = {};
      ds.forEach(d => { months[monthKey(d)] = (months[monthKey(d)] || 0) + 1; });
      let [y, m] = ds[0].slice(0, 7).split('-').map(Number);
      const [ly, lm] = ds[ds.length - 1].slice(0, 7).split('-').map(Number);
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
  const fomcDays = new Set((byKind.fomc || []).map(r => r.d));
  for (const r of byKind.minutes || []) {
    const dec = addDays(r.d, -21);
    if (!fomcDays.has(dec) && dec >= first) add('warn', 'minutes', `minutes ${r.d}: no FOMC decision listed on ${dec}, three weeks earlier.`, { k: 'minutes', d: r.d });
  }

  // 4. freshness and horizon per kind
  for (const k of Object.keys(IND.kinds)) {
    const list = byKind[k] || [], checked = (SCHED.checked || {})[k];
    if (!list.length) { add('error', 'empty', `${k}: nothing in schedule.json.`, { k }); continue; }
    const ahead = list.filter(r => r.d >= today).map(r => r.d).sort();
    if (!ahead.length) add('error', 'ended', `${k}: no future release left in schedule.json. Refresh the file.`, { k });
    else if (daysBetween(today, ahead[ahead.length - 1]) < 45) add('warn', 'horizon', `${k}: schedule runs out on ${ahead[ahead.length - 1]}. Refresh the file soon.`, { k });
    if (!checked) add('warn', 'unchecked', `${k}: no "checked" date, so nobody has confirmed it against the agency page.`, { k });
    else {
      const age = daysBetween(checked, today);
      if (age > 365) add('error', 'stale', `${k}: last checked ${checked} (${age} days ago).`, { k });
      else if (age > 120) add('warn', 'stale', `${k}: last checked ${checked} (${age} days ago). Agencies publish changes; re-check.`, { k });
    }
  }

  const counts = { official: 0, rule: 0, check: 0 };
  rel.forEach(r => { counts[r.v === 'rule' ? 'rule' : r.v === 'check' ? 'check' : 'official']++; });
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.lvl] - order[b.lvl]);
  const status = issues.some(i => i.lvl === 'error') ? 'error' : issues.some(i => i.lvl === 'warn') ? 'check' : 'ok';
  const checkedDates = Object.values(SCHED.checked || {}).sort();
  return { status, issues: issues.slice(0, 40), nIssues: issues.length, counts, total: rel.length, first, horizon: last,
    checked: checkedDates[0] || null, checkedNewest: checkedDates[checkedDates.length - 1] || null };
}

// ---- optional feed (Fair Economy / Forex Factory): forecast and previous, plus an independent check on dates and times ----
const rx = (IND, k) => (IND.kinds[k].match || []).map(s => new RegExp(s, 'i'));
export function feedKind(IND, title) {   // -> [kind, priority] or null
  for (const k of Object.keys(IND.kinds)) {
    const list = rx(IND, k);
    for (let i = 0; i < list.length; i++) if (list[i].test(title)) return [k, i];
  }
  return null;
}

// feed: [{t, title, imp, fc, pv, ac}] (USD high+medium). Returns { events, issues, matched }. Never throws on odd rows.
export function overlay(events, feed, IND, nowMs) {
  const evs = events.map(e => ({ ...e })), issues = [];
  const today = etParts(nowMs).iso, lim = addDays(today, 21);
  const byKey = new Map();   // kind|ET date -> schedule event
  for (const e of evs) byKey.set(`${e.k}|${e.d}`, e);
  const hits = new Map();    // schedule event -> [{pri, row}]
  const extras = [];
  for (const row of feed || []) {
    if (!row || !Number.isFinite(row.t)) continue;
    const p = etParts(row.t), kk = feedKind(IND, row.title || '');
    if (!kk) {
      if (p.iso >= today && p.iso <= lim && row.t > nowMs - 36e5) extras.push({ t: row.t, k: 'feed', title: row.title, imp: row.imp, agency: null, v: 'feed', n: 'Only in the unofficial feed. Not part of the official schedule, so it does not drive the countdown.',
        pd: null, d: p.iso, src: 'feed', fc: row.fc || null, pv: row.pv || null, ac: row.ac || null });
      continue;
    }
    const [k, pri] = kk, ev = byKey.get(`${k}|${p.iso}`);
    if (!ev) {
      // the feed has this release on a day the schedule does not: either the schedule moved or the feed is wrong
      if (p.iso >= today && p.iso <= lim && row.imp === 3) {
        const near = evs.find(e => e.k === k && e.t >= nowMs - DAY && Math.abs(daysBetween(e.d, p.iso)) <= 3);
        issues.push({ lvl: 'warn', code: 'feed_date', k, d: p.iso,
          msg: `Feed lists "${row.title}" on ${p.iso} ${p.hm} ET${near ? `, schedule has ${near.d} ${near.title}` : ', schedule has nothing near that date'}. One of them is wrong: check the agency page.` });
        if (near) near.flag = `feed says ${p.iso} ${p.hm} ET`;
      }
      continue;
    }
    (hits.get(ev) || hits.set(ev, []).get(ev)).push({ pri, row, p });
  }
  let matched = 0;
  for (const [ev, list] of hits) {
    list.sort((a, b) => a.pri - b.pri);
    const top = list[0];
    ev.fc = top.row.fc || null; ev.pv = top.row.pv || null; ev.ac = top.row.ac || null;
    ev.sub = list.slice(1, 5).map(x => ({ title: x.row.title, fc: x.row.fc || null, pv: x.row.pv || null, ac: x.row.ac || null }));
    matched++;
    const dt = Math.round((top.row.t - ev.t) / 60000);
    if (dt !== 0 && Math.abs(dt) < 24 * 60) {
      ev.flag = `feed says ${top.p.hm} ET, schedule says ${etParts(ev.t).hm} ET`;
      issues.push({ lvl: 'warn', code: 'feed_time', k: ev.k, d: ev.d, msg: `${ev.title} on ${ev.d}: feed says ${top.p.hm} ET but the schedule says ${etParts(ev.t).hm} ET. Check the agency page.` });
    }
  }
  return { events: evs.concat(extras).sort((a, b) => a.t - b.t), issues, matched, extras: extras.length };
}
