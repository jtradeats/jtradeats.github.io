// Policy facts and the policy backdrop (plan P8.9, D94 step 1, D95, R62). No AI and nothing typed by hand: the target range and every change come from FRED's
// DFEDTARU and DFEDTARL (daily, the day a new range takes effect), the decision dates from the schedule, and the vote from the Fed's own statement page when it can be read.
// Pure functions (no fetch): the Worker downloads the series and the statement and passes them in, so the tests use the same code.
import { etToMs } from './schedule.js';

export const POLICY_KV = 'policy:facts';
export const SERIES_U = 'DFEDTARU', SERIES_L = 'DFEDTARL';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayShort = iso => `${+iso.slice(8)} ${MON[+iso.slice(5, 7) - 1]}`;
const dayLong = iso => `${DOW[new Date(iso + 'T00:00:00Z').getUTCDay()]} ${dayShort(iso)}`;
const monthName = (iso, nowIso) => MONTH[+iso.slice(5, 7) - 1] + (iso.slice(0, 4) === String(nowIso).slice(0, 4) ? '' : ' ' + iso.slice(0, 4));
const monYear = iso => `${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const pct = x => x.toFixed(2);
const range = (u, l) => `${pct(l)}-${pct(u)}%`;
const bpOf = (a, b) => Math.round((a - b) * 100);

// Decision dates: the meetings in policy.json (already held, and the ones coming) joined with the schedule's FOMC decision rows, one entry per date, sorted.
// events: the expanded schedule (k 'fomc', r 'dec'). Each entry has t, the decision time in ms.
export function decisionList(cfg, events) {
  const m = new Map();
  for (const d of (cfg && cfg.decisions) || []) { const t = etToMs(`${d}T${(cfg && cfg.time) || '14:00'}`); if (t != null) m.set(d, { d, t }); }
  for (const e of events || []) if (e && e.k === 'fomc' && e.r === 'dec' && e.d && Number.isFinite(e.t) && !e.hol) m.set(e.d, { d: e.d, t: e.t });
  return [...m.values()].sort((a, b) => a.t - b.t);
}

// U, L: Map(date -> percent). Returns the facts, or null when the series cannot be read. now: ms; nowIso: today in New York.
// What each past decision did: a change that took effect from the decision day to 3 days later is that decision's change; no change and the series reaching the day after it is a hold;
// the series not reaching the day after it yet means the decision is not reflected (the series posts with a lag).
export function computeFacts(U, L, decs, now, nowIso) {
  const days = [...U.keys()].filter(d => L.has(d)).sort();
  if (days.length < 2) return null;
  const last = days[days.length - 1], u = U.get(last), l = L.get(last);
  let change = null;
  for (let i = days.length - 1; i > 0; i--) {
    const a = days[i], b = days[i - 1], du = bpOf(U.get(a), U.get(b)), dl = bpOf(L.get(a), L.get(b));
    if (du || dl) { change = { eff: a, bp: du || dl, from: [U.get(b), L.get(b)], to: [U.get(a), L.get(a)] }; break; }
  }
  const past = decs.filter(x => x.t <= now);
  const res = new Map();   // decision date -> 'hike' | 'cut' | 'hold' | null
  const chg = [];          // every change in the window, newest last
  for (let i = 1; i < days.length; i++) {
    const du = bpOf(U.get(days[i]), U.get(days[i - 1])), dl = bpOf(L.get(days[i]), L.get(days[i - 1]));
    if (du || dl) chg.push({ eff: days[i], bp: du || dl });
  }
  for (const x of past) {
    const c = chg.find(k => k.eff >= x.d && k.eff <= addDays(x.d, 3));
    res.set(x.d, c ? (c.bp > 0 ? 'hike' : 'cut') : last >= addDays(x.d, 1) ? 'hold' : null);
  }
  const lastDec = past.length ? past[past.length - 1] : null;
  let changeDec = null;
  if (change) { const m = past.filter(x => change.eff >= x.d && change.eff <= addDays(x.d, 3)); changeDec = m.length ? m[m.length - 1].d : null; }
  const since = change ? past.filter(x => x.d > (changeDec || change.eff) && res.get(x.d) === 'hold').map(x => x.d) : [];
  const nx = decs.find(x => x.t > now);
  return {
    asOfObs: last, upper: u, lower: l,
    change: change ? { eff: change.eff, bp: change.bp, decision: changeDec, range: range(change.to[0], change.to[1]), from: range(change.from[0], change.from[1]) } : null,
    decision: lastDec ? { d: lastDec.d, result: res.get(lastDec.d) || null, reflected: res.get(lastDec.d) != null } : null,
    holds: since,   // decision dates, after the last change, on which the Fed held
    next: nx ? nx.d : null,
    checked: nowIso, at: now,
  };
}

// The Fed's statement page: who voted against and what they preferred. Only what the page plainly says; anything else returns null and nothing is written in its place.
// "Voting against this action were A, who preferred to lower the target range by 1/2 percentage point; and B, who preferred no change." (one clause per preference)
const dec = s => s.replace(/&nbsp;|&#160;/g, ' ').replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/&#\d+;|&\w+;/g, ' ');
export function parseVotes(html) {
  const h = String(html || '');
  if (!/Voting for the monetary policy action/i.test(h)) return null;   // not the statement (or its layout changed)
  const i = h.search(/Voting against this action/i);
  if (i < 0) return { n: 0, dirs: {} };   // the voting paragraph is there and nobody voted against
  const para = dec(h.slice(i).split(/<\/p>/i)[0].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().replace(/^Voting against this action (?:was|were)\s*/i, '');
  const dirs = {}; let n = 0;
  for (const cl of para.replace(/\.$/, '').split(/;\s*(?:and\s+)?/)) {
    const m = /^(.*?),?\s+who\s+(?:preferred|favored|favoured)\s+(.*)$/i.exec(cl.trim());
    if (!m) return null;
    const names = m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map(x => x.trim()).filter(Boolean);
    const p = m[2], dir = /\b(?:raise|increase|higher)\b/i.test(p) ? 'hike' : /\b(?:lower|reduce|cut|decrease)\b/i.test(p) ? 'cut' : /\bno change|\bmaintain|\bkeep|\bunchanged\b/i.test(p) ? 'hold' : null;
    if (!names.length || !dir) return null;
    n += names.length; dirs[dir] = (dirs[dir] || 0) + names.length;
  }
  return n ? { n, dirs } : null;
}
export const statementUrl = d => `https://www.federalreserve.gov/newsevents/pressreleases/monetary${d.replace(/-/g, '')}a.htm`;
const WORD = { hike: 'a hike', cut: 'a cut', hold: 'no change' };
export function voteText(v) {
  if (!v) return '';
  if (v.n === 0) return 'No dissents at the latest meeting.';
  const parts = ['hike', 'cut', 'hold'].filter(k => v.dirs[k]).map(k => `${v.dirs[k]} preferred ${WORD[k]}`);
  return `${v.n} dissent${v.n > 1 ? 's' : ''} at the latest meeting (${parts.join(', ')}).`;
}

// The stance in the form fams_reviewed.stance uses: "last move: hike (Sep 2026); hold (Oct 2026)".
export function stanceOf(f) {
  if (!f || !f.decision || !f.decision.reflected) return null;
  const mv = f.change ? (f.change.bp > 0 ? 'hike' : 'cut') : 'none', md = f.change && (f.change.decision || f.change.eff);
  const lead = `last move: ${mv}${md ? ` (${monYear(md)})` : ''}`;
  return f.decision.result === 'hold' || !f.change ? `${lead}; ${f.decision.result} (${monYear(f.decision.d)})` : lead;
}
const key = s => { const m = /last move:\s*(hike|cut|none)/i.exec(s || ''); return m ? { move: m[1].toLowerCase(), held: /;\s*hold/i.test(s) } : null; };

// The backdrop the page shows. A decision whose time has passed and that the series does not show yet is never shown as the old range (R62).
// decs: decisionList(); facts: computeFacts() (as stored); vote: the parsed statement for facts.decision, or null.
export function policyBackdrop(facts, decs, now, nowIso, vote) {
  if (!facts || !facts.decision) return null;
  const latest = [...decs].filter(x => x.t <= now).pop();
  if (!latest) return null;
  const pending = latest.d > facts.decision.d || !facts.decision.reflected;
  const checked = facts.checked, src = 'Federal Reserve target range (FRED DFEDTARU and DFEDTARL) and the FOMC schedule' + (vote ? '; vote from the Fed statement' : '');
  if (pending) return { asof: latest.d, checked, built: true, pending: latest.d, src, text: `The FOMC decision of ${dayShort(latest.d)} is not yet reflected in the Fed's target-range data, so no range is shown. See the Fed statement.` };
  const f = facts, s = [];
  const rg = range(f.upper, f.lower);
  if (f.change) {
    const when = f.change.decision ? `in ${monthName(f.change.decision, nowIso)}` : `on ${dayShort(f.change.eff)}`;
    let t = `The Fed ${f.change.bp > 0 ? 'raised' : 'cut'} the target range by ${Math.abs(f.change.bp)} bp ${when} to ${f.change.range}`;
    const h = f.holds || [];
    if (h.length === 1) t += ` and held in ${monthName(h[0], nowIso)}`;
    else if (h.length > 1) t += ` and has held at the last ${h.length} meetings, most recently in ${monthName(h[h.length - 1], nowIso)}`;
    s.push(t + '.');
    if (f.change.range !== rg) s.push(`The target range is now ${rg}.`);   // a later change that no decision explains
  } else s.push(`The target range is ${rg}.`);
  if (vote) s.push(voteText(vote));
  if (f.next) s.push(`Next decision: ${dayLong(f.next)}.`);
  return { asof: f.decision.d, checked, built: true, pending: null, src, text: s.join(' ') };
}

// Issues for the schedule chip: the job has stopped, a decision is overdue in the data, the stance moved since the Fed lines were reviewed.
export function policyIssues(facts, decs, now, nowIso, reviewed, hasKey) {
  const out = [];
  if (!hasKey) return [{ lvl: 'warn', code: 'policy_nokey', k: 'fomc', msg: 'Policy facts need the secret FRED_KEY; the hand-written policy backdrop is shown instead.' }];
  if (!facts) return [{ lvl: 'warn', code: 'policy_none', k: 'fomc', msg: 'Policy facts have not been built yet; the hand-written policy backdrop is shown until they are.' }];
  const hrs = (now - facts.at) / 36e5;
  if (hrs > 36) out.push({ lvl: 'warn', code: 'policy_stale', k: 'fomc', msg: `Policy facts were last confirmed ${Math.round(hrs)} hours ago (the job runs daily). The backdrop on the page may be out of date.` });
  const late = [...decs].filter(x => x.t <= now - 3 * 864e5).pop();
  if (late && facts.decision && late.d > facts.decision.d) out.push({ lvl: 'warn', code: 'policy_overdue', k: 'fomc', d: late.d, msg: `The ${dayShort(late.d)} FOMC decision is more than 3 days old and the policy facts still stop at ${dayShort(facts.decision.d)}. Check the job and the series.` });
  if (facts.decision && facts.decision.reflected && facts.change && !facts.change.decision && decs.length && facts.change.eff >= decs[0].d) out.push({ lvl: 'info', code: 'policy_unscheduled', k: 'fomc', d: facts.change.eff, msg: `The target range changed on ${dayShort(facts.change.eff)}, which matches no FOMC decision date in the schedule. Check the dates in policy.json.` });
  const a = key(reviewed && reviewed.stance), b = stanceOf(facts) && key(stanceOf(facts));
  if (a && b && (a.move !== b.move || a.held !== b.held)) out.push({ lvl: 'warn', code: 'stance_changed', k: 'fomc', msg: `The policy stance is now "${stanceOf(facts)}" but the Fed explanations were reviewed for "${reviewed.stance}". Re-read them and update fams_reviewed in indicators.json.` });
  return out;
}
