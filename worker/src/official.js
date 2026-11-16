// Official actuals (plan 3.5, first slice): the release's own number, computed from FRED series that republish BLS and DOL data. With the secret FRED_KEY the Worker uses FRED's API; without it, the keyless CSV (which Cloudflare's addresses are refused on).
// Pure functions (no fetch): the Worker downloads the series and passes the parsed series in, so the tests use the same code.
// Fills an actual (and a revised previous) only where the row has none; never overwrites a typed or provider number.
// Where a typed or provider actual disagrees with the official one within 3 days of the print, the row is flagged instead.
// A wire actual (sr.ac 'FJ', from wire.js) is the exception: the official number confirms it (the tag becomes FRED) or replaces it (the row keeps the wire's number in wfix and is flagged).
import { fmtVal } from './schedule.js';

// key = "<kind>|<row id>" in schedule.json / indicators.json. per: the release covers a week (claims), a month (named in the line's "p": Oct) or a quarter (Q3).
// f: level = the series value; diff = change from the prior period (payrolls, thousands); mom / yoy = % change (1 decimal, as published).
// k: multiplier into the units fmtVal expects (JOLTS is in thousands, shown as millions); auto:'persons' scales a series given in persons to thousands.
// Not covered (no FRED series that publishes with the release): ISM, S&P Global, Chicago and Conference Board surveys, EIA crude stocks, Treasury auction yields, the Fed decision
// and durable goods (FRED's DGORDER carries the full M3 report a week after the advance print the calendar shows, so it would fill the wrong number late).
export const SPEC = {
  'claims|main': { s: 'ICSA', per: 'week', f: 'level', u: 'K' },
  'nfp|nfp': { s: 'PAYEMS', per: 'month', f: 'diff', u: 'K' },
  'nfp|unemp': { s: 'UNRATE', per: 'month', f: 'level', u: '%' },
  'nfp|ahe': { s: 'CES0500000003', per: 'month', f: 'mom', u: '%' },
  'cpi|mom': { s: 'CPIAUCSL', per: 'month', f: 'mom', u: '%' },
  'cpi|core': { s: 'CPILFESL', per: 'month', f: 'mom', u: '%' },
  'cpi|yoy': { s: 'CPIAUCNS', per: 'month', f: 'yoy', u: '%' },   // the published year-on-year uses the not-seasonally-adjusted index
  'ppi|mom': { s: 'PPIFIS', per: 'month', f: 'mom', u: '%' },   // final demand, seasonally adjusted
  'retail|main': { s: 'RSAFS', per: 'month', f: 'mom', u: '%' },   // advance retail and food services
  'retail|core': { s: 'RSFSXMV', per: 'month', f: 'mom', u: '%' },   // excluding motor vehicles and parts
  'gdp|main': { s: 'A191RL1Q225SBEA', per: 'quarter', f: 'level', u: '%' },   // annualised real growth, as BEA publishes it
  'pce|mom': { s: 'PCEPILFE', per: 'month', f: 'mom', u: '%' },   // core PCE price index
  'pce|yoy': { s: 'PCEPILFE', per: 'month', f: 'yoy', u: '%' },
  'jolts|main': { s: 'JTSJOL', per: 'month', f: 'level', u: 'M', k: 1000 },   // FRED: thousands
  'adp|main': { s: 'ADPMNUSNERSA', per: 'month', f: 'diff', u: 'K', auto: 'persons' },
  'nhs|main': { s: 'HSN1F', per: 'month', f: 'level', u: 'K' },   // thousands, annual rate
  'ehs|main': { s: 'EXHOSLUSM495S', per: 'month', f: 'level', u: 'M' },   // units, annual rate
  'philly|main': { s: 'GACDFSA066MSFRBPHI', per: 'month', f: 'level', u: '' },   // current general activity, seasonally adjusted
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

// FRED's official API (api.stlouisfed.org, free key, secret FRED_KEY). The keyless graph CSV above is refused from Cloudflare's addresses (HTTP 520);
// the API is meant for programs. Same Map as parseFredCsv, so everything downstream is unchanged. Missing values are "." and are skipped.
export const fredApiUrl = (series, key, since) =>
  `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${since}`;
export function parseFredJson(text) {
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('FRED API: not JSON'); }
  if (!j || !Array.isArray(j.observations)) throw new Error(`FRED API: ${String((j && (j.error_message || j.message)) || 'unexpected payload').slice(0, 100)}`);
  const m = new Map();
  for (const o of j.observations) {
    const x = Number(o && o.value);
    if (o && o.date && o.value != null && String(o.value).trim() !== '' && String(o.value).trim() !== '.' && Number.isFinite(x)) m.set(String(o.date).trim(), x);
  }
  return m;
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const shiftMonth = (iso, n) => { const [y, m] = iso.split('-').map(Number), t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}-01`; };
const prevObs = (obs, spec) => (spec.per === 'week' ? addDays(obs, -7) : spec.per === 'quarter' ? shiftMonth(obs, -3) : shiftMonth(obs, -1));

// the series date an event refers to: claims -> the Saturday before the release; monthly -> the reference month named in the line's "p" (Oct on 6 Nov)
export function obsFor(e, spec) {
  if (spec.per === 'week') { const dow = new Date(e.d + 'T00:00:00Z').getUTCDay(); return addDays(e.d, -(((dow + 1) % 7) || 7)); }
  const [y, mo] = e.d.split('-').map(Number);
  if (spec.per === 'quarter') {   // "Q3" -> 1 July; the fourth quarter is reported in January to March, so it belongs to the year before
    const q = /^Q([1-4])$/i.exec(String(e.pd || '').trim());
    if (!q) return null;
    const sm = (+q[1] - 1) * 3 + 1;
    return `${sm > mo ? y - 1 : y}-${String(sm).padStart(2, '0')}-01`;
  }
  const m = MON.indexOf(String(e.pd || '').slice(0, 3).toLowerCase());
  if (m < 0) return null;
  return `${m + 1 > mo ? y - 1 : y}-${String(m + 1).padStart(2, '0')}-01`;
}

export function calc(S, spec, obs) {
  const v = S.get(obs);
  if (v == null) return null;
  let x;
  const k = spec.auto === 'persons' ? (v >= 1e7 ? 0.001 : 1) : (spec.k || 1);   // into the unit fmtVal expects
  if (spec.f === 'level') return v * k;
  if (spec.f === 'yoy') { const y = S.get(shiftMonth(obs, -12)); if (y == null) return null; x = (v / y - 1) * 100; }
  else {
    const p = S.get(prevObs(obs, spec));
    if (p == null) return null;
    if (spec.f === 'diff') return (v - p) * k;
    x = (v / p - 1) * 100;
  }
  return Math.round(x * 10) / 10 || 0;   // || 0 turns -0 into 0
}

const num = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

// events: the calendar events (sorted by time), M: { SERIES: Map }, now: ms. Returns { n, issues }.
export function applyOfficial(events, M, now) {
  let n = 0;
  const issues = [], last = new Map(), wire = [];
  for (const e of events) {
    const key = e.k + '|' + e.r, spec = SPEC[key], before = last.get(key);
    last.set(key, e);
    if (!spec || e.hol || e.src === 'feed' || e.t > now || e.t < now - 45 * 864e5) continue;   // not released yet, or too old to trust a later vintage
    const S = M && M[spec.s], obs = S && obsFor(e, spec), a = obs && calc(S, spec, obs);
    if (a == null) continue;
    const act = fmtVal(a, spec.u);
    if (e.ac == null) { e.ac = act; (e.sr = e.sr || {}).ac = 'FRED'; n++; }
    else if (e.sr && e.sr.ac === 'FJ') {   // first figure came from the wire: the official series settles it
      const agree = num(e.ac) === num(act);
      wire.push({ id: e.id, t: e.t, fj: e.ac, off: act, agree });
      if (!agree) {
        e.wfix = e.ac;
        e.ac = act;
        e.flag = `FinancialJuice said ${e.wfix}, FRED (official series) says ${act}; showing ${act}`;
        issues.push({ lvl: 'warn', code: 'wire_corrected', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}.` });
      }
      e.sr.ac = 'FRED';
    }
    else if (num(e.ac) !== num(act) && e.t > now - 3 * 864e5) {
      const who = e.sr && e.sr.ac ? e.sr.ac : 'this row';
      e.flag = `FRED (official series) says ${act}, ${who} says ${e.ac}`;
      issues.push({ lvl: 'warn', code: 'official_diff', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}. Check the agency release.` });
    }
    const pv = calc(S, spec, prevObs(obs, spec));
    if (pv == null) continue;
    const ps = fmtVal(pv, spec.u);
    if (e.pv == null || (e.sr && e.sr.pv === 'FJ')) { e.pv = ps; (e.sr = e.sr || {}).pv = 'FRED'; }   // the wire's "previous" is the figure before revisions: the official series wins
    // revised previous: the official value for the prior period differs from what that release first showed
    if (!e.pvc && before && before.ac != null && num(before.ac) !== num(ps)) {
      const inv = e.dir === 'inv' || e.dir === 'oil';
      e.pvc = (num(ps) > num(before.ac)) !== inv ? 'g' : 'r';
      e.pv = ps; (e.sr = e.sr || {}).pv = 'FRED';
    }
  }
  return { n, issues, wire };
}
