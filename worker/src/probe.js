// probe.js: the CPU probe (plan P8.47, 28 Nov). A switch for finding where the two cron ticks spend their CPU, read from one variable and always OFF unless it is set, valid and unexpired.
// Why it exists: the minute tick (* * * * *) and the */2 tick are over 10 ms in 56% and 67% of their runs and make up 81% of the slow runs (§1.4 #7), but a stopwatch inside the Worker cannot
// say which step costs what (Workers' clock does not move during CPU work). The fair measure is Observability's CPU time per trigger, so the probe switches one step off (or swaps it for the lean
// version that already exists in feed.js) for 30 to 60 minutes and the step whose removal drops the median is the cost.
//
// Set it in Cloudflare: Workers & Pages, market-dashboard, Settings, Variables and Secrets, Add variable, type Text, name CPU_PROBE.
//   value  <mode>[+<mode>...]@<UTC expiry>      e.g.   lean@2026-11-29T01:00:00Z      or      lean+nopush@2026-11-29T01:00Z
// The expiry is part of the value on purpose: a probe someone forgot to switch off stops by itself, and a value without an expiry, with a bad one or with one more than 24 hours away is ignored (and /health says why).
// Remove the variable when the measurement is done. Modes (the tick they touch, and what stops while it is on):
//   minute0  minute tick: return at once. The floor cost of a tick (isolate wake, handler). Wire polling and phone alerts pause.
//   lean     minute tick: poll with pollFeedsBg (feed.js) instead of getFeeds + JSON.parse. Nothing pauses; a full parse of the Telegram page happens at most every 10 minutes while the newest post id is unchanged.
//   nopush   minute tick: skip pushNew (and the alert list it builds). Phone alerts for the wire pause.
//   quiet0   */2 tick, on a quiet minute (not a multiple of 10): return right after loadSync. Reminders and the policy daily run pause.
//   quiet1   */2 tick, on a quiet minute: return after the schedule and release-near scan. Reminders and the policy daily run pause.
// Run it while the markets are closed (a probe that skips a tick can delay a reminder or an alert).

export const PROBE_MODES = ['minute0', 'lean', 'nopush', 'quiet0', 'quiet1'];
export const PROBE_MAX_MS = 24 * 3600 * 1000;   // an expiry further away than this is refused

// -> { modes: string[], until: ms | null, active: boolean, error: string | null }. modes is empty whenever active is false.
export function parseProbe(value, now = Date.now()) {
  const off = error => ({ modes: [], until: null, active: false, error });
  if (value == null || value === '') return off(null);
  if (typeof value !== 'string' || value.length > 120) return off('CPU_PROBE is not a short text value');
  const at = value.lastIndexOf('@');
  if (at < 1) return off('no expiry: write <mode>@<UTC time>, e.g. lean@2026-11-29T01:00:00Z');
  const names = value.slice(0, at).split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bad = names.find(n => !PROBE_MODES.includes(n));
  if (!names.length || bad) return off(bad ? 'unknown mode: ' + bad.slice(0, 20) : 'no mode');
  const until = Date.parse(value.slice(at + 1).trim());
  if (!Number.isFinite(until)) return off('the expiry is not a time');
  if (until - now > PROBE_MAX_MS) return off('the expiry is more than 24 hours away');
  const modes = [...new Set(names)];
  if (now >= until) return { modes: [], until, active: false, error: 'expired' };
  return { modes, until, active: true, error: null };
}

// the modes that are on right now (an empty list when the probe is off, expired or invalid)
export const probeModes = (env, now = Date.now()) => parseProbe(env && env.CPU_PROBE, now).modes;

// for /health: null when no variable is set, else what the Worker made of it
export function probeHealth(env, now = Date.now()) {
  const raw = env && env.CPU_PROBE;
  if (raw == null || raw === '') return null;
  const p = parseProbe(raw, now);
  return { active: p.active, modes: p.modes, until: p.until ? new Date(p.until).toISOString().replace(/\.\d+Z$/, 'Z') : null, minutes_left: p.active ? Math.round((p.until - now) / 60000) : null, error: p.error };
}
