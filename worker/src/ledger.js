// The actuals ledger (plan P8.30): the best actual each release has shown, with the source that gave it, kept in KV.
// Why: the official numbers (FRED) and the calendar-feed copies live in the Worker's memory. After a few idle hours the Worker starts cold,
// holds nothing until the sources answer again, and a source that lapses for a moment left only the wire's first number (tagged fj).
// The ledger is the floor under every live source: a number is put back only when the live sources show none, or a lesser one.
// A live source of the same or higher rank always wins, and a revised number of the same rank replaces the ledger's copy.
// The forecast is kept too (fc, with its source sf): the Forex Factory file drops last week's releases when its week rolls over on Sunday, and the wire's own memo is dropped after 3 days,
// so without this a released row loses its forecast (and the green or red of its actual) within days.
// Upcoming releases are covered too, for the forecast only (P8.38): the calendar feed answers 429 most of the time and its saved copy is not laid over the schedule after 12 hours,
// so a forecast that was on screen yesterday used to vanish overnight and come back when the feed next answered. Actuals and revised previous figures are still kept for released rows only.
// One small KV object (key calendar:ledger), written only when an entry is added or changes: a few writes a day against the 1,000 free ones.

export const LG_KV = 'calendar:ledger';
export const LG_AFTER_MAX = 45 * 864e5;   // only releases from the last 45 days are kept (the same limit as the official series)
export const LG_KEEP = 400 * 864e5;       // rows older than this are dropped (was 60 days). The ledger is the long-term record of what each release showed: actual, forecast and where each came from.
//   A row is about 100 bytes, so a year of releases is roughly 30 KB in one KV value (limit 25 MB).

// who gave the number. The wire fills blanks only, so a calendar-feed copy outranks it; FRED outranks both. A typed placeholder ('ref') is not a source.
const RANK = { FRED: 4, EIA: 4, 'Fair Economy': 3, FMP: 3, Finviz: 2.5, FJ: 2 };   // Finviz (P8.44): above the wire, below Forex Factory, so the two never swap places in the ledger   // EIA: the agency's own API (official.js, P8.33), same rank as FRED
export const rankOf = tag => RANK[tag] || 0;

export const newLedger = () => ({ v: 1, rows: {} });
export const fromKv = o => (o && o.v === 1 && o.rows && typeof o.rows === 'object' ? o : newLedger());

const usable = e => e && !e.hol && e.src !== 'feed' && e.id && Number.isFinite(e.t);
const has = v => v != null && v !== '';

// Call after every live source has been applied. Returns true when the ledger changed.
export function recordLedger(mem, events, now) {
  let changed = false;
  for (const e of events || []) {
    if (!usable(e) || e.t < now - LG_AFTER_MAX) continue;
    const out = e.t <= now;   // released: actuals and the revised previous are kept; an upcoming row keeps its forecast only
    const sr = e.sr || {}, r0 = mem.rows[e.id];
    const ar = rankOf(sr.ac);
    if (out && has(e.ac) && ar >= 2) {
      const r = r0 || (mem.rows[e.id] = { t: e.t });
      if (!has(r.ac) || ar > rankOf(r.sa) || (ar === rankOf(r.sa) && String(r.ac) !== String(e.ac))) { r.ac = e.ac; r.sa = sr.ac; r.at = now; changed = true; }
    }
    // the forecast the calendar feed or the wire gave (rank 2 or more; a typed placeholder is not a source)
    if (has(e.fc) && rankOf(sr.fc) >= 2) {
      const fr = rankOf(sr.fc), r = mem.rows[e.id] || (mem.rows[e.id] = { t: e.t });
      if (!has(r.fc) || fr > rankOf(r.sf) || (fr === rankOf(r.sf) && String(r.fc) !== String(e.fc))) { r.fc = e.fc; r.sf = sr.fc; r.at = now; changed = true; }
    }
    // the revised previous the official series gave (it carries the green or red underline)
    if (out && has(e.pv) && rankOf(sr.pv) === 4) {
      const r = mem.rows[e.id] || (mem.rows[e.id] = { t: e.t });
      if (String(r.pv) !== String(e.pv) || (r.pvc || null) !== (e.pvc || null) || (r.sp || 'FRED') !== sr.pv) { r.pv = e.pv; r.pvc = e.pvc || null; r.sp = sr.pv; r.at = now; changed = true; }
    }
  }
  return changed;
}

// Call after recordLedger's inputs are final but before the response is built. Puts back what the live sources lost. Returns how many fields it restored.
export function applyLedger(events, mem, now) {
  let n = 0;
  for (const e of events || []) {
    if (!usable(e)) continue;
    const r = mem.rows[e.id];
    if (!r) continue;
    const sr = e.sr || {}, out = e.t <= now;
    if (out && has(r.ac) && (!has(e.ac) || rankOf(r.sa) > rankOf(sr.ac))) {
      e.ac = r.ac; (e.sr = e.sr || {}).ac = r.sa; n++;
    }
    if (has(r.fc) && (!has(e.fc) || rankOf(r.sf) > rankOf(sr.fc))) {
      e.fc = r.fc; (e.sr = e.sr || {}).fc = r.sf; n++;
    }
    if (out && has(r.pv) && rankOf(e.sr ? e.sr.pv : undefined) < 4) {
      e.pv = r.pv; (e.sr = e.sr || {}).pv = r.sp || 'FRED';
      if (r.pvc) e.pvc = r.pvc; else delete e.pvc;
      n++;
    }
  }
  return n;
}

export function pruneLedger(mem, now) {
  let changed = false;
  for (const [id, r] of Object.entries(mem.rows)) if (!r || !(r.t > now - LG_KEEP)) { delete mem.rows[id]; changed = true; }
  return changed;
}

// Released rows that the wire covers (covered(e) is true) and that still lack a forecast, a previous or an actual, after every source and the ledger have been applied.
// For /calendar?debug=1 (gaps) and the health line (ledger.gaps); index.js's wire backfill uses the same test. Newest first. Only releases from the last LG_AFTER_MAX are listed.
export function forecastGaps(events, now, covered) {
  const out = [];
  for (const e of events || []) {
    if (!usable(e) || e.t > now || e.t < now - LG_AFTER_MAX || (covered && !covered(e))) continue;
    const miss = [];
    if (!has(e.fc)) miss.push('fc');
    if (!has(e.pv)) miss.push('pv');
    if (!has(e.ac)) miss.push('ac');
    if (miss.length) out.push({ id: e.id, t: e.t, miss });
  }
  return out.sort((a, b) => b.t - a.t);
}
