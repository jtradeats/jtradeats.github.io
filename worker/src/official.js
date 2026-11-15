// Official actuals (plan 3.5, first slice): the release's own number, computed from FRED series that republish BLS and DOL data. No key.
// Pure functions (no fetch): the Worker downloads the CSVs and passes the parsed series in, so the tests use the same code.
// Fills an actual (and a revised previous) only where the row has none; never overwrites a typed or provider number.
// Where a typed or provider actual disagrees with the official one within 3 days of the print, the row is flagged instead.
import { fmtVal } from './schedule.js';

// key = "<kind>|<row id>" in schedule.json / indicators.json. per: the release covers a week (claims) or a month (named in the line's "p").
// f: level = the series value; diff = change from the prior period (payrolls, thousands); mom / yoy = % change (1 decimal, as published).
export const SPEC = {
  'claims|main': { s: 'ICSA', per: 'week', f: 'level', u: 'K' },
  'nfp|nfp': { s: 'PAYEMS', per: 'month', f: 'diff', u: 'K' },
  'nfp|unemp': { s: 'UNRATE', per: 'month', f: 'level', u: '%' },
  'nfp|ahe': { s: 'CES0500000003', per: 'month', f: 'mom', u: '%' },
  'cpi|mom': { s: 'CPIAUCSL', per: 'month', f: 'mom', u: '%' },
  'cpi|core': { s: 'CPILFESL', per: 'month', f: 'mom', u: '%' },
  'cpi|yoy': { s: 'CPIAUCNS', per: 'month', f: 'yoy', u: '%' },   // the published year-on-year uses the not-seasonally-adjusted index
};
export const SERIES = [...new Set(Object.values(SPEC).map(x => x.s))];

// FRED graph CSV -> Map(date -> number). Header is "observation_date,SERIES" or "DATE,SERIES"; missing values are "." or empty.
export function parseFredCsv(text) {
  const m = new Map();
  for (const l of String(text).trim().split(/\r?\n/).slice(1)) {
    const [d, v] = l.split(',');
    const x = Number(v);
    if (d && v != null && v.trim() !== '' && v.trim() !== '.' && Number.isFinite(x)) m.set(d.trim(), x);
  }
  return m;
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const shiftMonth = (iso, n) => { const [y, m] = iso.split('-').map(Number), t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}-01`; };
const prevObs = (obs, spec) => (spec.per === 'week' ? addDays(obs, -7) : shiftMonth(obs, -1));

// the series date an event refers to: claims -> the Saturday before the release; monthly -> the reference month named in the line's "p" (Oct on 6 Nov)
export function obsFor(e, spec) {
  if (spec.per === 'week') { const dow = new Date(e.d + 'T00:00:00Z').getUTCDay(); return addDays(e.d, -(((dow + 1) % 7) || 7)); }
  const m = MON.indexOf(String(e.pd || '').slice(0, 3).toLowerCase());
  if (m < 0) return null;
  const [y, mo] = e.d.split('-').map(Number);
  return `${m + 1 > mo ? y - 1 : y}-${String(m + 1).padStart(2, '0')}-01`;
}

export function calc(S, spec, obs) {
  const v = S.get(obs);
  if (v == null) return null;
  let x;
  if (spec.f === 'level') return v;
  if (spec.f === 'yoy') { const y = S.get(shiftMonth(obs, -12)); if (y == null) return null; x = (v / y - 1) * 100; }
  else {
    const p = S.get(prevObs(obs, spec));
    if (p == null) return null;
    if (spec.f === 'diff') return v - p;
    x = (v / p - 1) * 100;
  }
  return Math.round(x * 10) / 10 || 0;   // || 0 turns -0 into 0
}

const num = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

// events: the calendar events (sorted by time), M: { SERIES: Map }, now: ms. Returns { n, issues }.
export function applyOfficial(events, M, now) {
  let n = 0;
  const issues = [], last = new Map();
  for (const e of events) {
    const key = e.k + '|' + e.r, spec = SPEC[key], before = last.get(key);
    last.set(key, e);
    if (!spec || e.hol || e.src === 'feed' || e.t > now || e.t < now - 45 * 864e5) continue;   // not released yet, or too old to trust a later vintage
    const S = M && M[spec.s], obs = S && obsFor(e, spec), a = obs && calc(S, spec, obs);
    if (a == null) continue;
    const act = fmtVal(a, spec.u);
    if (e.ac == null) { e.ac = act; (e.sr = e.sr || {}).ac = 'FRED'; n++; }
    else if (num(e.ac) !== num(act) && e.t > now - 3 * 864e5) {
      const who = e.sr && e.sr.ac ? e.sr.ac : 'this row';
      e.flag = `FRED (official series) says ${act}, ${who} says ${e.ac}`;
      issues.push({ lvl: 'warn', code: 'official_diff', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}. Check the agency release.` });
    }
    const pv = calc(S, spec, prevObs(obs, spec));
    if (pv == null) continue;
    const ps = fmtVal(pv, spec.u);
    if (e.pv == null) { e.pv = ps; (e.sr = e.sr || {}).pv = 'FRED'; }
    // revised previous: the official value for the prior period differs from what that release first showed
    if (!e.pvc && before && before.ac != null && num(before.ac) !== num(ps)) {
      const inv = e.dir === 'inv' || e.dir === 'oil';
      e.pvc = (num(ps) > num(before.ac)) !== inv ? 'g' : 'r';
      e.pv = ps; (e.sr = e.sr || {}).pv = 'FRED';
    }
  }
  return { n, issues };
}
