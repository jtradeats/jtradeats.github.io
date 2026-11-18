// Wire actuals (plan P8.19, stage 2): the first number of a release, read from the FinancialJuice posts, shown tagged "FJ" until an
// official source (FRED, a typed number) confirms or corrects it. Pure functions (no fetch): index.js passes the posts in, so the tests use the same code.
//
// What a post looks like (cleaned by feed.js: the "|FJ" tail and a leading red mark are removed):
//   "‼ BREAKING: US NONFARM PAYROLLS ACTUAL 165K (FORECAST 70K, PREVIOUS 29K) $MACRO"      (‼ is U+203C, not the red mark, so feed.js does not call it hot)
//   "EIA CRUDE OIL INVENTORIES ACTUAL 4.657M (FORECAST -1.483M, PREVIOUS -0.865M) $MACRO"   (no "US ", no mark)
//   "US 30 Yr Note Auction\n\nHigh Yield 5.441% [Tail 0.4 BPS]\nBid-to-cover 2.36 ..."       (an auction: the actual is the high yield, no forecast)
// A post carries no reference period, so a post belongs to the row whose release time it follows: post time within
// [release - 30 s, release + 45 min]. A post about last month's release is therefore never matched to this month's row.
//
// Rules of the fill (D117):
//   - fills a blank actual, forecast or previous only; never overwrites a typed number (results.json) or a provider number
//   - the number must pass the row's bounds and its unit must fit the row (K, M, %, plain)
//   - two different actuals for one row from two posts: the first stays, the row is flagged, the official number decides
//   - official.js replaces it silently when FRED agrees, and replaces it with a visible correction when FRED differs
//   - kept in a small memo (isolate memory + one KV key) so the number outlives the 50-post window and a cold start
import { fmtVal } from './schedule.js';

export const WIRE_KV = 'wire:actuals';
export const WIRE_BEFORE = 30e3;          // a post can carry a timestamp a few seconds before the scheduled minute
export const WIRE_AFTER = 45 * 60e3;      // after this a post is not taken for this release (the page's release alert uses the same 45 min)
const KEEP_MS = 3 * 864e5, LOG_MAX = 60, INGEST_MAX_AGE = 6 * 3600e3;

// names: the wire's own name for the release, upper case, without "US " and without the mark. keys: rows of indicators.json ("<kind>|<row id>").
// lo/hi: plausibility bounds in the row's unit (K rows in thousands, M rows in millions, % rows in percent). dp: fixed decimals shown.
// seen: 1 = wording confirmed from a real post; 0 = wording assumed from the same template (harmless if wrong: no match, no fill).
const R = (names, keys, lo, hi, o = {}) => ({ names: [].concat(names), keys: [].concat(keys), lo, hi, seen: 0, ...o });
export const RULES = [
  R('NONFARM PAYROLLS', 'nfp|nfp', -1500, 1500, { seen: 1 }),
  R('CPI MOM', 'cpi|mom', -3, 3, { seen: 1 }),
  R('CORE CPI MOM', 'cpi|core', -2, 2, { seen: 1 }),
  R('PPI MOM', 'ppi|mom', -5, 5, { seen: 1 }),
  R('INITIAL JOBLESS CLAIMS', 'claims|main', 80, 1000, { seen: 1 }),
  R('JOLTS JOB OPENINGS', 'jolts|main', 3, 15, { seen: 1 }),
  R('ADP EMPLOYMENT CHANGE', 'adp|main', -800, 1000, { seen: 1 }),
  R('RETAIL SALES MOM', 'retail|main', -6, 6, { seen: 1 }),
  R('EIA CRUDE OIL INVENTORIES', 'eia|main', -30, 30, { seen: 1 }),
  R('INTEREST RATE DECISION', 'fomc|dec', 0, 12, { seen: 1, dp: 2 }),
  // wording not yet seen: send the posts and these become seen:1 (or get corrected)
  R('UNEMPLOYMENT RATE', 'nfp|unemp', 1, 25),
  R('AVERAGE HOURLY EARNINGS MOM', 'nfp|ahe', -2, 3),
  R('CPI YOY', 'cpi|yoy', -3, 25),
  R(['RETAIL SALES EX AUTOS MOM', 'CORE RETAIL SALES MOM'], 'retail|core', -6, 6),
  R('CORE PCE PRICE INDEX MOM', 'pce|mom', -2, 3),
  R('CORE PCE PRICE INDEX YOY', 'pce|yoy', -1, 15),
  R('GDP QOQ', 'gdp|main', -15, 15),
  R('DURABLE GOODS ORDERS MOM', 'dgo|main', -25, 25),
  R('NEW HOME SALES', 'nhs|main', 200, 1500),
  R('EXISTING HOME SALES', 'ehs|main', 1.5, 8),
  R('ISM MANUFACTURING PMI', 'ism_m|pmi', 20, 80),
  R(['ISM SERVICES PMI', 'ISM NON MANUFACTURING PMI', 'ISM NON-MANUFACTURING PMI'], 'ism_s|pmi', 20, 80),
  R('ISM MANUFACTURING PRICES', 'ism_m|prices', 20, 110),
  R(['ISM SERVICES PRICES', 'ISM NON MANUFACTURING PRICES', 'ISM NON-MANUFACTURING PRICES'], 'ism_s|prices', 20, 110),
  R('S&P GLOBAL MANUFACTURING PMI', ['spg_m|main', 'spg_f|mfg'], 20, 80),
  R('S&P GLOBAL SERVICES PMI', ['spg_s|main', 'spg_f|svc'], 20, 80),
  R('CHICAGO PMI', 'chi|main', 20, 90),
  R(['CB CONSUMER CONFIDENCE', 'CONSUMER CONFIDENCE'], 'cb|main', 30, 160),
  R(['PHILADELPHIA FED MANUFACTURING INDEX', 'PHILLY FED MANUFACTURING INDEX'], 'philly|main', -80, 80),
];
const BY_NAME = new Map();
for (const r of RULES) for (const n of r.names) BY_NAME.set(n, r);
// Treasury auctions: the 10-year note and the 30-year bond (FJ calls both "Note Auction"). TIPS reopenings do not match: "TIPS" is not "NOTE" or "BOND".
const AUCTION = { 10: 'auc10|main', 30: 'auc30|main' };
export const WIRE_KEYS = new Set([...RULES.flatMap(r => r.keys), ...Object.values(AUCTION)]);

const LEAD = /^[\s*\u203C\u2757\uFE0F]*(?:BREAKING\s*:?\s*)?/i;   // "‼ BREAKING:" and a red mark are both removed
const MACRO = /^(?:US\s+)?(.+?)\s+ACTUAL\s+(-?\d[\d,]*\.?\d*)\s*([KMB%]?)\s*\(\s*FORECAST\s+(-?\d[\d,]*\.?\d*)\s*([KMB%]?)\s*(?:,\s*PREVIOUS\s+(-?\d[\d,]*\.?\d*)\s*([KMB%]?)\s*)?\)/i;
const AUC = /^US\s+(\d+)\s*YR\s+(NOTE|BOND)\s+AUCTION\b[\s\S]*?HIGH\s+YIELD\s+(\d+\.\d+)\s*%/i;
const tok = (n, s) => (n == null ? null : { n: parseFloat(String(n).replace(/,/g, '')), s: String(s || '').toUpperCase() });

// text -> null (not a release post) | { kind, name, rule, ac, fc, pv }; rule is null for a release name nobody mapped yet. ac/fc/pv are { n, s } tokens.
export function parseWire(text) {
  const s = String(text || '').replace(LEAD, '').trim();
  let m = AUC.exec(s);
  if (m) {
    const key = AUCTION[+m[1]];
    return { kind: 'auction', name: `${m[1]} YR ${m[2].toUpperCase()} AUCTION`, rule: key ? { names: [`${m[1]} YR AUCTION`], keys: [key], lo: 0.5, hi: 12, dp: 3, u: '%', seen: 1 } : null, ac: tok(m[3], '%'), fc: null, pv: null };
  }
  m = MACRO.exec(s);
  if (!m) return null;
  const name = m[1].toUpperCase().replace(/\s+/g, ' ').trim();
  return { kind: 'macro', name, rule: BY_NAME.get(name) || null, ac: tok(m[2], m[3]), fc: tok(m[4], m[5]), pv: tok(m[6], m[7]) };
}

// token -> number in the row's unit, or null when the unit does not fit the row
export function inRowUnit(t, u) {
  if (!t || !Number.isFinite(t.n)) return null;
  if (u === '%') return t.s === '%' ? t.n : null;
  if (u === 'K') return t.s === 'K' ? t.n : t.s === 'M' ? t.n * 1000 : null;
  if (u === 'M') return t.s === 'M' ? t.n : t.s === 'K' ? t.n / 1000 : null;
  return t.s === '' ? t.n : null;   // plain index (PMIs)
}
const show = (x, u, dp) => (x == null ? null : dp != null ? x.toFixed(dp) + (u === '%' ? '%' : '') : fmtVal(x, u));
const num = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

export const newMemo = () => ({ v: 1, rows: {}, log: [] });
export function pruneMemo(memo, now) {
  for (const [id, r] of Object.entries(memo.rows)) if (now - r.seen > KEEP_MS) delete memo.rows[id];
  if (memo.log.length > LOG_MAX) memo.log = memo.log.slice(-LOG_MAX);
}

// events: the calendar events (after applyResults); posts: the FinancialJuice window, any order; memo: newMemo() shape; now: ms.
// Mutates the events (fill) and the memo (new numbers). Returns { n, issues, unmatched, changed }.
export function applyWire(events, posts, now, memo) {
  const issues = [], unmatched = [];
  let changed = false, n = 0;
  const byKey = new Map();
  for (const e of events) {
    if (e.hol || e.src === 'feed') continue;
    const k = e.k + '|' + e.r;
    if (WIRE_KEYS.has(k)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
  }
  for (const p of posts || []) {
    if (!p || p.t == null || now - p.t > INGEST_MAX_AGE) continue;
    const x = parseWire(p.text);
    if (!x) continue;
    if (!x.rule) { unmatched.push({ id: p.id, t: p.t, text: String(p.text).replace(/\s+/g, ' ').slice(0, 110) }); continue; }
    const cands = [];
    for (const k of x.rule.keys) for (const e of byKey.get(k) || []) if (p.t >= e.t - WIRE_BEFORE && p.t <= e.t + WIRE_AFTER) cands.push(e);
    if (!cands.length) continue;                       // not this release (an older or a later one): never matched by name alone
    const e = cands.sort((a, b) => b.t - a.t)[0], u = x.rule.u || e.u;
    const a = inRowUnit(x.ac, u);
    if (a == null || a < x.rule.lo || a > x.rule.hi) {
      issues.push({ lvl: 'warn', code: 'wire_rejected', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: the FinancialJuice number ${x.ac.n}${x.ac.s} was rejected (unit or range) and is not shown.` });
      continue;
    }
    const ac = show(a, u, x.rule.dp), have = memo.rows[e.id];
    if (have) {
      if (have.pid !== p.id && num(have.ac) !== num(ac) && !have.alt) { have.alt = ac; changed = true; }   // a second, different actual: keep the first, flag it
      continue;
    }
    const f = inRowUnit(x.fc, u), pr = inRowUnit(x.pv, u);
    memo.rows[e.id] = { ac, fc: show(f, u, x.rule.dp), pv: show(pr, u, x.rule.dp), pid: p.id, pt: p.t, seen: now, rule: x.rule.names[0], g: x.rule.seen ? 0 : 1 };
    changed = true;
  }
  pruneMemo(memo, now);
  for (const e of events) {
    const r = memo.rows[e.id];
    if (!r || e.hol) continue;
    const sr = e.sr = e.sr || {};
    const typed = f => sr[f] === 'ref';   // a hand-typed placeholder counts as blank: the wire's number replaces it
    if (e.ac == null || typed('ac')) { e.ac = r.ac; sr.ac = 'FJ'; n++; }
    if ((e.fc == null || typed('fc')) && r.fc != null) { e.fc = r.fc; sr.fc = 'FJ'; }
    if ((e.pv == null || typed('pv')) && r.pv != null) { e.pv = r.pv; sr.pv = 'FJ'; delete e.pvc; }
    if (r.alt && sr.ac === 'FJ') {
      e.flag = `FinancialJuice posted ${r.ac} and then ${r.alt}; showing the first`;
      issues.push({ lvl: 'warn', code: 'wire_conflict', k: e.k, d: e.d, msg: `${e.title} on ${e.d}: ${e.flag}.` });
    }
  }
  return { n, issues, unmatched: unmatched.slice(0, 10), changed };
}

// list: what applyOfficial saw for rows the wire had filled: [{ id, t, fj, off, agree }]. One log entry per row (the first comparison).
export function recordConfirms(memo, list, now) {
  let changed = false;
  for (const c of list || []) {
    if (memo.log.some(x => x.id === c.id)) continue;
    const r = memo.rows[c.id];
    memo.log.push({ id: c.id, fj: c.fj, off: c.off, agree: !!c.agree, postLagS: r ? Math.round((r.pt - c.t) / 1000) : null, seenLagS: r ? Math.round((r.seen - c.t) / 1000) : null, at: now });
    changed = true;
  }
  return changed;
}

// for /calendar?debug=1 and /health: how often the wire matched the official number, and how soon after the release it posted
export function wireSummary(memo) {
  const log = memo.log || [], agree = log.filter(x => x.agree).length, lags = log.map(x => x.postLagS).filter(x => x != null).sort((a, b) => a - b);
  return { rows: Object.keys(memo.rows).length, compared: log.length, agree, disagree: log.length - agree,
    postLagMedianS: lags.length ? lags[Math.floor(lags.length / 2)] : null, postLagMaxS: lags.length ? lags[lags.length - 1] : null,
    last: log.slice(-5) };
}
