// Price validation (plan P8.16): V1 range and V2 jump. Pure functions, shared by /market (index.js), /sectors and /weekly (route.js), and the
// range part by the TradingView push (tv.js, through index.js). Ranges and move limits live in config/symbols.json, per item:
//   "range": [min, max]   V1. A price outside it is rejected as if the source had failed: the next source in the chain is tried, and when none
//                         answers the item keeps its last good value, tagged STALE, with the reason in "why". The bands are wide on purpose
//                         ("this cannot be the price"), so a real move is never refused.
//   "move": N             V2. A move from the prior close larger than N (percent; points for a yield) is shown, but tagged UNVERIFIED ("unv": true,
//                         reason in "why") unless the previous reading, made within 10 minutes, is already close to it (within a quarter of N).
//                         A real big day passes at the next fetch; a bad tick does not repeat. The tag clears by itself.
// An item with neither field is not checked.

export const V2_RECENT_MS = 10 * 60000;   // an older reading cannot confirm a jump (a weekend gap, a cold start from the KV snapshot)

const okRange = r => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1];

// symbols.json items -> { label: { label, kind, range, move } } for the items that carry a rule
export function rulesFrom(items) {
  const out = {};
  for (const i of items || []) {
    if (!i || !i.label) continue;
    const range = okRange(i.range) ? [i.range[0], i.range[1]] : null, move = Number(i.move) > 0 ? Number(i.move) : null;
    if (range || move) out[i.label] = { label: i.label, kind: i.kind, range, move };
  }
  return out;
}

// V1: null when the price is acceptable (or there is no range), else an Error with .range = true, whose message is the reason shown on the tile
export function rangeFail(rule, p) {
  if (!rule || !rule.range) return null;
  const [lo, hi] = rule.range;
  if (Number.isFinite(p) && p >= lo && p <= hi) return null;
  const e = new Error(`V1: ${rule.label} ${+Number(p).toFixed(4)} is outside the range ${lo} to ${hi}; the last good value is kept`);
  e.range = true;
  return e;
}

// the move that V2 measures: percent from the prior close; a yield's change in points (its percent change means nothing)
export function moveOf(rule, q) {
  const yl = rule && rule.kind === 'yield', m = yl ? q.c : q.pc;
  return Number.isFinite(m) ? Math.abs(m) : null;
}

// V2: { unv, why }. q: the new reading { p, c, pc }. prior: the previous reading of the same item { p, f } or nothing. now: ms.
export function checkJump(rule, q, prior, now) {
  const thr = rule && rule.move;
  if (!(thr > 0)) return { unv: false, why: null };
  const mv = moveOf(rule, q);
  if (mv == null || mv <= thr) return { unv: false, why: null };
  const yl = rule.kind === 'yield', tol = thr / 4;
  const near = prior && Number.isFinite(prior.p) && Number.isFinite(prior.f) && now >= prior.f && now - prior.f <= V2_RECENT_MS
    && (yl ? Math.abs(prior.p - q.p) : Math.abs(prior.p / q.p - 1) * 100) <= tol;
  if (near) return { unv: false, why: null };   // the move was already there at the last fetch: this reading agrees with it
  return { unv: true, why: `V2: ${rule.label} moved ${mv.toFixed(yl ? 2 : 1)}${yl ? ' pt' : '%'} from the prior close (limit ${thr}); shown as unverified until the next fetch agrees` };
}
