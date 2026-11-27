// Official actuals (plan 3.5, first slice): the release's own number, computed from FRED series that republish BLS and DOL data. With the secret FRED_KEY the Worker uses FRED's API; without it, the keyless CSV (which Cloudflare's addresses are refused on).
// Pure functions (no fetch): the Worker downloads the series and passes the parsed series in, so the tests use the same code.
// Fills an actual (and a revised previous) only where the row has none; never overwrites a typed or provider number.
// Where a typed or provider actual disagrees with the official one within 3 days of the print, the row is flagged instead.
// A wire actual (sr.ac 'FJ', from wire.js) is the exception: the official number confirms it (the tag becomes FRED) or replaces it (the row keeps the wire's number in wfix and is flagged).
import { fmtVal } from './schedule.js';

// key = "<kind>|<row id>" in schedule.json / indicators.json. per: the release covers a week (claims), a month (named in the line's "p": Oct) or a quarter (Q3).
// f: level = the series value; diff = change from the prior period (payrolls, thousands); mom / yoy = % change (1 decimal, as published).
// k: multiplier into the units fmtVal expects (JOLTS is in thousands, shown as millions); auto:'persons' scales a series given in persons to thousands.
// Not covered (no FRED series that publishes with the release): ISM, S&P Global, Chicago and Conference Board surveys, Treasury auction yields, the Fed decision
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
  // EIA crude (P8.33): not FRED but EIA's own API v2 (secret EIA_KEY). s starts with 'EIA:' so index.js knows which API to ask. wk:'fri' = the series date is the Friday that ends the week before the Wednesday release
  // (a Thursday release after a holiday still refers to the Friday before it). WCESTUS1 is in thousand barrels; k turns it into millions and dp keeps 3 decimals (4657 * 0.001 is 4.657000000000001). tag: what the row shows as its source.
  'eia|main': { s: 'EIA:WCESTUS1', per: 'week', wk: 'fri', f: 'diff', u: 'M', k: 0.001, dp: 3, tag: 'EIA' },   // commercial crude excluding the SPR, week-on-week change
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

// ---- vintages (plan P8.18). BEA publishes three estimates of each quarter's GDP (advance, second, third) and FRED keeps one value per quarter, replacing it when BEA revises.
// Until FRED has done that, the quarter's value is the EARLIER estimate, so reading it as the second or third estimate's actual would show a stale number as official.
// FRED's API can say when a value last changed: with realtime_start set it returns one row per value the observation held, each with the day that value began (realtime_start).
// "The value began on or after the release day" is then read directly instead of guessed. (Response shape: observations[] with realtime_start, realtime_end, date, value.)
export const REVISION = /^(second|third) estimate\b/i;   // the note on a calendar line for a later estimate of the same quarter
export const VINTAGE_SERIES = new Set(['A191RL1Q225SBEA']);
export const fredVintageUrl = (series, key, since, from) => `${fredApiUrl(series, key, since)}&realtime_start=${encodeURIComponent(from)}&realtime_end=9999-12-31`;
// -> Map(date -> { v, rs }): the newest value of each observation and the day it began. A later row for the same date wins only if it began later.
export function parseFredVintage(text) {
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('FRED API: not JSON'); }
  if (!j || !Array.isArray(j.observations)) throw new Error(`FRED API: ${String((j && (j.error_message || j.message)) || 'unexpected payload').slice(0, 100)}`);
  const m = new Map();
  for (const o of j.observations) {
    const x = Number(o && o.value), rs = o && String(o.realtime_start || '').slice(0, 10);
    if (!o || !o.date || !rs || o.value == null || String(o.value).trim() === '' || String(o.value).trim() === '.' || !Number.isFinite(x)) continue;
    const d = String(o.date).trim(), cur = m.get(d);
    if (!cur || rs >= cur.rs) m.set(d, { v: x, rs });
  }
  return m;
}

// EIA API v2 (api.eia.gov, free key, secret EIA_KEY): weekly stocks, route petroleum/stoc/wstk. Same Map as the FRED parsers (period -> number), so everything downstream is unchanged.
// `id` is the series without the 'EIA:' prefix. Values arrive as strings in thousand barrels (units MBBL).
export const eiaApiUrl = (id, key, since) => {
  const q = new URLSearchParams({ api_key: key, frequency: 'weekly', 'data[0]': 'value', 'facets[series][]': id, start: since, 'sort[0][column]': 'period', 'sort[0][direction]': 'asc', length: '500' });
  return `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${q}`;
};
export function parseEiaJson(text) {
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('EIA API: not JSON'); }
  const d = j && j.response && j.response.data;
  if (!Array.isArray(d)) throw new Error(`EIA API: ${String((j && (j.error || (j.response && j.response.error) || j.message)) || 'unexpected payload').slice(0, 100)}`);
  const m = new Map();
  for (const o of d) {
    const x = Number(o && o.value);
    if (o && o.period && o.value != null && String(o.value).trim() !== '' && Number.isFinite(x)) m.set(String(o.period).trim(), x);
  }
  return m;
}

// how a computed number is written: EIA rows keep three decimals as the reference calendar does (3.380M, not 3.38M); every other row uses fmtVal as before
const fv = (x, sp) => (sp.dp != null && sp.u === 'M' ? x.toFixed(sp.dp) + 'M' : fmtVal(x, sp.u));

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const shiftMonth = (iso, n) => { const [y, m] = iso.split('-').map(Number), t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}-01`; };
const prevObs = (obs, spec) => (spec.per === 'week' ? addDays(obs, -7) : spec.per === 'quarter' ? shiftMonth(obs, -3) : shiftMonth(obs, -1));

// the series date an event refers to: claims -> the Saturday before the release; monthly -> the reference month named in the line's "p" (Oct on 6 Nov)
export function obsFor(e, spec) {
  if (spec.wk === 'fri') return addDays(e.d, -(((new Date(e.d + 'T00:00:00Z').getUTCDay() + 2) % 7) || 7));   // the Friday strictly before the release day
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
    if (spec.f === 'diff') { const d = (v - p) * k; return spec.dp != null ? Number(d.toFixed(spec.dp)) : d; }
    x = (v / p - 1) * 100;
  }
  return Math.round(x * 10) / 10 || 0;   // || 0 turns -0 into 0
}

const num = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

// Has FRED taken up this later estimate? opts.vint(series, obs) -> { v, rs } or nothing. With vintage data it is exact; without it, the value must differ from the earlier estimate.
// A later estimate that equals the earlier one stays pending when there is no vintage data (accuracy over coverage: the wire still supplies the number, tagged as the wire's).
function revisionTaken(e, spec, S, obs, act, before, opts) {
  const vi = opts.vint && opts.vint(spec.s, obs);
  if (vi) {
    if (vi.rs < e.d) return { ok: false, why: `FRED's value for ${obs} has held since ${vi.rs}, before the ${e.d} release: still the earlier estimate` };
    if (vi.v !== S.get(obs)) return { ok: false, why: `FRED's series and its vintage disagree for ${obs} (${S.get(obs)} against ${vi.v}); waiting for them to agree` };
    return { ok: true };
  }
  const refs = [e.pv, before && ((opts.ac0 && opts.ac0(before.id)) ?? before.ac)].filter(x => x != null && Number.isFinite(num(x)));
  if (!refs.length) return { ok: false, why: `no earlier estimate to compare ${act} with, and no vintage data` };
  if (refs.some(x => num(x) === num(act))) return { ok: false, why: `FRED still shows ${act}, the earlier estimate (no vintage data to say otherwise)` };
  return { ok: true };
}

// Covered rows (the ones FRED answers) that have been out for up to 6 hours and still have no actual: the page shows "awaiting official figure" for them.
// Called after every source has had its turn, so a number from the wire or the ledger is not called missing.
// 25 Nov: the label appeared at +0 min on claims, GDP and core PCE while the wire's figure was a minute away, and it overlapped the forecast on a phone. A row the wire covers
// (covered(e) true) gets no label for its first PENDING_GRACE; after that the label says no first figure has come. Rows the wire does not cover are labelled at once, as before.
export const PENDING_GRACE = 10 * 60e3;
export function markPending(events, now, covered) {
  const out = [];
  for (const e of events) {
    if (!SPEC[e.k + '|' + e.r] || e.hol || e.src === 'feed' || e.ac != null || e.t > now || e.t < now - 6 * 36e5) continue;
    if (covered && covered(e) && now - e.t < PENDING_GRACE) continue;
    e.aw = 1;
    out.push({ id: e.id, min: Math.round((now - e.t) / 60000) });
  }
  return out;
}

// The previous of a later GDP estimate (second, third) is the PRIOR QUARTER's growth, as for every other row (26 Nov, J: Bloomberg, Investing and Finviz all show Q2's 2.2% against the Q3 second estimate),
// not the earlier estimate of the same quarter. FRED holds the prior quarter, so no number has to be typed. Used for upcoming later estimates and for released ones FRED has not taken up yet.
function priorQuarter(e, spec, S, tag) {
  const obs = S && obsFor(e, spec), p = obs && calc(S, spec, prevObs(obs, spec));
  if (p == null) return false;
  const ps = fv(p, spec), sr = e.sr = e.sr || {};
  if (e.pv == null || num(e.pv) !== num(ps)) e.pv = ps;   // the same number spelled another way keeps its text
  sr.pv = tag; delete e.pvc;   // a revision mark compares with the earlier release's actual, which is another measure of the quarter: none for a later estimate
  return true;
}

// events: the calendar events (sorted by time), M: { SERIES: Map }, now: ms. Returns { n, issues, wire, skipped }.
// opts.vint(series, obs): when FRED last changed a value (parseFredVintage), for the later GDP estimates. opts.pv0(id) / opts.ac0(id): the remembered "previous" a release showed before any revision, and the first actual of a release (src/firstprint.js). Without them the earlier release in the list is used.
export function applyOfficial(events, M, now, opts = {}) {
  let n = 0;
  const issues = [], last = new Map(), wire = [], skipped = [];
  for (const e of events) {
    const key = e.k + '|' + e.r, spec = SPEC[key], before = last.get(key);
    last.set(key, e);
    if (spec && !e.hol && e.src !== 'feed' && e.t > now && REVISION.test(String(e.n || ''))) { priorQuarter(e, spec, M && M[spec.s], spec.tag || 'FRED'); continue; }   // an upcoming second or third estimate: its previous is the prior quarter
    if (!spec || e.hol || e.src === 'feed' || e.t > now || e.t < now - 45 * 864e5) continue;   // not released yet, or too old to trust a later vintage
    const S = M && M[spec.s], obs = S && obsFor(e, spec), a = obs && calc(S, spec, obs);
    if (a == null) {
      if (obs && S.get(obs) != null) skipped.push({ id: e.id, why: `no base for ${spec.f === 'yoy' ? shiftMonth(obs, -12) : prevObs(obs, spec)}` });   // the observation exists but the figure needs an earlier one
      continue;
    }
    const act = fv(a, spec), tag = spec.tag || 'FRED', who0 = tag === 'FRED' ? 'FRED (official series)' : tag, rev = REVISION.test(String(e.n || ''));   // tag: the source the row shows
    // A revised series holds only the NEWEST estimate of a quarter. If its value began after this release day it belongs to a later estimate: the advance row of 29 Oct showed the second
    // estimate's 4.3% in place of 3.4% (26 Nov), and the second row would show the third estimate's figure after 23 Dec. Such a row keeps what the wire, Finviz or the ledger gave it.
    const vi0 = VINTAGE_SERIES.has(spec.s) && opts.vint && opts.vint(spec.s, obs);
    if (vi0 && vi0.rs > e.d) {
      skipped.push({ id: e.id, why: `FRED's value for ${obs} began on ${vi0.rs}, after this ${e.d} release: it is a later estimate, not this release's figure` });
      const vp = opts.vint && opts.vint(spec.s, prevObs(obs, spec));   // the prior quarter is still readable when it has not changed since this release (29 Oct: Q2 2.2%, unchanged since 10 Oct)
      if (vp && vp.rs <= e.d) priorQuarter(e, spec, S, tag);
      continue;
    }
    if (rev) {   // second or third estimate: FRED's value may still be the earlier one
      const g = revisionTaken(e, spec, S, obs, act, before, opts);
      if (!g.ok) { skipped.push({ id: e.id, why: g.why }); priorQuarter(e, spec, S, tag); continue; }
    }
    // blank, or only a hand-typed placeholder. A typed actual is replaced only in the first 3 days: the series later carries revised vintages, and a past release's actual is its first print.
    if (e.ac == null || (e.sr && e.sr.ac === 'ref' && e.t > now - 3 * 864e5)) { e.ac = e.ac != null && num(e.ac) === num(act) ? e.ac : act; (e.sr = e.sr || {}).ac = tag; n++; }   // the same number typed another way ("7.190M" and "7.19M") keeps its text
    else if (e.sr && (e.sr.ac === 'FJ' || e.sr.ac === 'Finviz')) {   // first figure came from the wire or from Finviz: the official series settles it
      const fromWire = e.sr.ac === 'FJ', first = fromWire ? 'FinancialJuice' : 'Finviz', agree = num(e.ac) === num(act);
      if (fromWire) wire.push({ id: e.id, t: e.t, fj: e.ac, off: act, agree });   // the agree and disagree log is about the wire only
      if (/^FinancialJuice said .*, Finviz says /.test(String(e.flag || ''))) delete e.flag;   // the unofficial disagreement is settled now
      delete e.cf;
      if (!agree) {
        e.wfix = e.ac;
        if (!fromWire) e.wsrc = first;   // whose figure was replaced (the correction alert names it)
        e.ac = act;
        e.flag = `${first} said ${e.wfix}, ${who0} says ${act}; showing ${act}`;
        issues.push({ lvl: 'warn', code: 'wire_corrected', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}.` });
      }
      e.sr.ac = tag;
    }
    else if (num(e.ac) !== num(act) && e.t > now - 3 * 864e5) {
      const who = e.sr && e.sr.ac ? e.sr.ac : 'this row';
      e.flag = `${who0} says ${act}, ${who} says ${e.ac}`;
      issues.push({ lvl: 'warn', code: 'official_diff', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}. Check the agency release.` });
    }
    if (rev) { priorQuarter(e, spec, S, tag); continue; }   // a later estimate's previous is the prior quarter (see priorQuarter), taken from the series like every other row's
    const pv = calc(S, spec, prevObs(obs, spec));
    if (pv == null) continue;
    const ps = fv(pv, spec), sr = e.sr = e.sr || {};
    // what the market saw as "previous" before this release: remembered before any revision, else the earlier release's first actual
    const ref = (opts.pv0 && opts.pv0(e.id)) ?? (before ? ((opts.ac0 && opts.ac0(before.id)) ?? before.ac) : null);
    // The official series carries the revisions, so for a released row its previous replaces a feed, wire or typed one (a provider's file can lag the revised number by hours).
    // The same number spelled another way keeps its text. A typed revision mark went with the typed number; it is worked out again here.
    if (sr.pv === 'ref') delete e.pvc;
    if (e.pv == null || num(e.pv) !== num(ps)) e.pv = ps;
    sr.pv = tag;
    if (ref != null && num(ref) !== num(ps)) {   // revised: shown underlined, green when the revision is good news for the row
      const inv = e.dir === 'inv' || e.dir === 'oil';
      e.pvc = (num(ps) > num(ref)) !== inv ? 'g' : 'r';
    } else delete e.pvc;
  }
  return { n, issues, wire, skipped };
}
// ---- history (P8.40). applyOfficial above leaves a release alone after 45 days, because FRED then holds a REVISED value, not the one the calendar showed.
// FRED's archive (ALFRED) can say what a series looked like on a given day: with realtime_start = realtime_end = the release day the response is the series as it stood then,
// so the actual computed from it is the first print and the previous is the previous as revised in that very release. One request per (series, release day), answered once and
// kept for good in the ledger (index.js: histFill), so last month's rows keep their official numbers after the 45 days are over.
export const HIST_MIN_AGE = 45 * 864e5;   // the age at which applyOfficial stops (keep equal to its window)
export const fredAsOfUrl = (series, key, since, asof) => `${fredApiUrl(series, key, since)}&realtime_start=${encodeURIComponent(asof)}&realtime_end=${encodeURIComponent(asof)}`;
// S: Map(date -> number) as it stood on the release day (or the current series for EIA stocks, which are not revised). -> { ac, pv } as text, or null
export function histNumbers(S, spec, e) {
  const obs = S && obsFor(e, spec);
  if (!obs) return null;
  const a = calc(S, spec, obs);
  if (a == null) return null;
  const p = calc(S, spec, prevObs(obs, spec));
  return { ac: fv(a, spec), pv: p == null ? null : fv(p, spec) };
}
