// First prints (plan P8.23): what each release showed BEFORE any revision, remembered so a revised "previous" can be underlined without hand-typed marks.
//   pv0: the "previous" the calendar showed for the release before the official series was applied (the number the market saw: it is the pre-revision value).
//   ac0: the first actual a real source gave (never a typed placeholder), taken within 3 days of the release.
// The official FRED series carries the revised previous; when it differs from pv0 (or from the earlier release's ac0) the page underlines it.
// One small KV object (key calendar:first), written only when an entry is added: a handful of writes a day against the 1,000 free ones.

export const FP_KV = 'calendar:first';
export const FP_BEFORE = 36 * 3600e3;    // start remembering a release's "previous" this long before it
export const FP_AFTER = 3 * 864e5;       // a first print is only taken in the first 3 days; later numbers are revisions
export const FP_KEEP = 60 * 864e5;       // rows older than this are dropped

export const newFirst = () => ({ v: 1, rows: {} });

// the object read back from KV, or a fresh one when it is missing or malformed
export const fromKv = o => (o && o.v === 1 && o.rows && typeof o.rows === 'object' ? o : newFirst());

const usable = e => e && !e.hol && e.src !== 'feed' && e.id && Number.isFinite(e.t);

// Call after the calendar feeds, typed placeholders and the wire have been applied and BEFORE the official series: e.pv is then still the pre-revision number.
// A typed placeholder is not a real source, so it is not remembered. Returns true when something was added.
export function recordPrev(mem, events, now) {
  let changed = false;
  for (const e of events || []) {
    if (!usable(e) || e.t > now + FP_BEFORE || e.t < now - FP_AFTER) continue;
    if (e.pv == null || (e.sr && e.sr.pv === 'ref')) continue;
    const r = mem.rows[e.id] || (mem.rows[e.id] = { t: e.t });
    if (r.pv0 == null) { r.pv0 = e.pv; changed = true; }
  }
  return changed;
}

// Call after the official series has been applied. Remembers the first real actual of each release, in its first 3 days.
export function recordActual(mem, events, now) {
  let changed = false;
  for (const e of events || []) {
    if (!usable(e) || e.t > now || e.t < now - FP_AFTER) continue;
    if (e.ac == null || (e.sr && e.sr.ac === 'ref')) continue;
    const r = mem.rows[e.id] || (mem.rows[e.id] = { t: e.t });
    if (r.ac0 == null) { r.ac0 = e.ac; changed = true; }
  }
  return changed;
}

export function prune(mem, now) {
  let changed = false;
  for (const [id, r] of Object.entries(mem.rows)) if (!r || !(r.t > now - FP_KEEP)) { delete mem.rows[id]; changed = true; }
  return changed;
}

// the two lookups applyOfficial takes
export const lookups = mem => ({
  pv0: id => (mem.rows[id] && mem.rows[id].pv0) ?? null,
  ac0: id => (mem.rows[id] && mem.rows[id].ac0) ?? null,
});
