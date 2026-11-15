// Treasury yield curve (plan P6): official daily par yield curve, spreads, changes, history. Pure functions, no fetch:
// the Worker downloads the Treasury CSV (the download the tape already uses) and FRED's T10Y2Y and passes the parsed data in.
// Official end-of-day close only: the card shows its as-of date and never mixes it with the delayed intraday tape (R5, R44).

// Treasury's header names drift (a "1.5 Month" column appeared in 2025): columns are read by name, any tenor may be missing.
// "2 Yr" -> "2Y", "1 Mo" -> "1M", "1.5 Month" -> "1.5M".
export function tenorKey(h) {
  const m = /^(\d+(?:\.\d+)?)\s*(mo|month|months|yr|year|years)\b/i.exec(String(h).trim());
  return m ? `${+m[1]}${/^y/i.test(m[2]) ? 'Y' : 'M'}` : null;
}
export const CURVE_TENORS = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'];   // the Curve view (1M to 30Y)
export const SPREADS = [
  { id: '10s2s', label: '10Y−2Y', a: '10Y', b: '2Y' },
  { id: '30s10s', label: '30Y−10Y', a: '30Y', b: '10Y' },
  { id: '10y3m', label: '10Y−3M', a: '10Y', b: '3M' },
  { id: '30s5s', label: '30Y−5Y', a: '30Y', b: '5Y' },
];
export const STATE_BP = 5;      // a spread that moved 5 bp or more over a month is steepening or compressing, otherwise flat
export const KEEP = 275;        // sessions kept (this year and last): enough for the 12-month change at any time of year
const YIELDS = ['3M', '2Y', '5Y', '10Y', '30Y'];

// CSV text -> [{ Date: '11/13/2026', '1 Mo': '4.01', ... }] (keyed by header name; the same shape the tape's loader returned)
export function parseTreasuryCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const clean = s => s.replace(/"/g, '').trim();
  const head = lines[0].split(',').map(clean);
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const c = l.split(',').map(clean), o = {};
    head.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}

const isoOf = s => {            // "11/13/2026" -> "2026-11-13"; an ISO date passes through
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null;
};
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const addMonths = (iso, n) => {   // same day of the month, clamped (31 Mar - 1 month = 28 Feb)
  const [y, m, d] = iso.split('-').map(Number), t = y * 12 + (m - 1) + n, yy = Math.floor(t / 12), mm = t % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const bp = x => Math.round(x * 100 + 1e-9 * Math.sign(x));   // yields are published to 2 decimals: round away float noise

// rows (objects keyed by header, from any number of years) -> sessions [{ d, y: { '2Y': 4.1, ... } }] oldest first, one per date
export function normalize(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const d = isoOf(r.Date);
    if (!d) continue;
    const y = {};
    for (const h in r) {
      if (h === 'Date') continue;
      const k = tenorKey(h), v = r[h];
      if (!k || v == null || v === '' || /^n\/?a$/i.test(v)) continue;
      const x = Number(v);
      if (Number.isFinite(x)) y[k] = x;
    }
    if (Object.keys(y).length) by.set(d, { d, y });
  }
  return [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

// the last session on or before `iso`, or null if the history starts later
function onOrBefore(S, iso) {
  let lo = 0, hi = S.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (S[mid].d <= iso) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at < 0 ? null : S[at];
}

const val = (s, k) => (s && s.y[k] != null ? s.y[k] : null);
const diff = (a, b) => (a == null || b == null ? null : bp(a - b));
const spreadAt = (s, sp) => { const a = val(s, sp.a), b = val(s, sp.b); return a == null || b == null ? null : bp(a - b); };

export function stateOf(m1) {
  if (m1 == null) return null;
  return m1 >= STATE_BP ? 'steepening' : m1 <= -STATE_BP ? 'compressing' : 'flat';
}

// fred: Map(date -> percent) of T10Y2Y (optional). now: ms.
export function buildCurve(rows, fred, now = Date.now()) {
  const S = normalize(rows).slice(-KEEP);
  if (S.length < 2) throw new Error('fewer than 2 sessions in the Treasury data');
  const last = S[S.length - 1], prev = S[S.length - 2];
  const ref = {
    d1: prev,
    w1: onOrBefore(S, addDays(last.d, -7)),
    m1: onOrBefore(S, addMonths(last.d, -1)),
    y1: onOrBefore(S, addMonths(last.d, -12)),
  };
  // onOrBefore returns null when the history starts later, so an unknown lookback stays unknown (never "the first session")

  const yields = YIELDS.filter(k => val(last, k) != null).map(k => {
    const v = val(last, k), o = { k, v };
    for (const r in ref) o[r] = diff(v, val(ref[r], k));
    return o;
  });
  const spreads = SPREADS.map(sp => {
    const now_ = spreadAt(last, sp);
    if (now_ == null) return { id: sp.id, label: sp.label, bp: null };
    const o = { id: sp.id, label: sp.label, bp: now_, inv: now_ < 0 };
    for (const r in ref) { const p = spreadAt(ref[r], sp); o[r] = p == null ? null : now_ - p; }
    o.state = stateOf(o.m1);
    return o;
  });
  const row = s => CURVE_TENORS.map(k => val(s, k));
  const out = {
    asof: last.d, sessions: S.length, first: S[0].d,
    dates: { d1: prev.d, w1: ref.w1 && ref.w1.d, m1: ref.m1 && ref.m1.d, y1: ref.y1 && ref.y1.d },
    yields, spreads,
    curve: { tenors: CURVE_TENORS, latest: row(last), m1: ref.m1 ? row(ref.m1) : null, y1: ref.y1 ? row(ref.y1) : null },
    hist: { dates: S.map(s => s.d), y2: S.map(s => val(s, '2Y')), y10: S.map(s => val(s, '10Y')), y30: S.map(s => val(s, '30Y')) },
  };
  out.check = crossCheck(last, fred);
  out.age_days = Math.floor((now - Date.parse(last.d + 'T00:00:00Z')) / 864e5);
  return out;
}

// our 10Y-2Y against FRED's T10Y2Y (percent, same Treasury source, republished): they should match to the basis point
export function crossCheck(last, fred) {
  const ours = spreadAt(last, SPREADS[0]);
  if (ours == null) return { id: 'T10Y2Y', status: 'unavailable', note: 'no 10Y or 2Y in the latest Treasury row' };
  if (!fred || !fred.size) return { id: 'T10Y2Y', status: 'unavailable', ours, note: 'FRED not reached' };
  const f = fred.get(last.d);
  if (f == null) return { id: 'T10Y2Y', status: 'pending', ours, note: 'FRED has not posted this date yet' };   // it often trails Treasury by a few hours
  const d = bp(f) - ours;
  return { id: 'T10Y2Y', status: Math.abs(d) <= 1 ? 'ok' : 'differs', ours, fred: bp(f), diffBp: d };
}
