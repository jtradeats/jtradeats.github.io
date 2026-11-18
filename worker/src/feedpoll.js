// Forex Factory (Fair Economy) refresh plan (P8.24). The weekly JSON rate-limits shared Cloudflare addresses (HTTP 429), so the Worker asks as little as it can
// and as often as it must: both files every 30 minutes in quiet hours, but only THIS week's file, every 5 minutes, from 10 minutes before a scheduled release
// until 45 minutes after it (forecasts and revised previouses move around a release). Pure functions here; src/index.js does the fetching.

export const FF_FAST = 5 * 60000;          // inside a release window
export const FF_SLOW = 30 * 60000;         // otherwise
export const FF_PRE = 10 * 60000, FF_POST = 45 * 60000;
export const FF_RETRY = 5 * 60000;         // after a failed poll, and after a 429 inside a release window
export const FF_RETRY_429 = 15 * 60000;    // after a 429 in quiet hours

// events: the schedule's events. A release window is open when an official (not provider-only) release is due within FF_PRE or happened within FF_POST.
export const ffHot = (events, now) => (events || []).some(e => e && !e.hol && e.src !== 'feed' && Number.isFinite(e.t) && e.t <= now + FF_PRE && e.t >= now - FF_POST);

export const ffTtl = hot => (hot ? FF_FAST : FF_SLOW);

// how long to leave the feed alone after a failure
export const ffRetry = (rate, hot) => (rate && !hot ? FF_RETRY_429 : FF_RETRY);

// A fast poll fetches only this week's file, so it must not throw away what the previous copy knew about next week.
// prev: the events held now (or null), fresh: the events just read from this week's file. Next week's events are the ones after this week's last event.
export function mergeFeed(prev, fresh) {
  if (!fresh || !fresh.length) return prev || [];   // an empty answer is more likely a hiccup than a week with no releases: keep what is held
  if (!prev || !prev.length) return fresh;
  const edge = Math.max(...fresh.map(e => e.t)) + 6 * 3600e3;
  return fresh.concat(prev.filter(e => e.t > edge)).sort((a, b) => a.t - b.t);
}

// the status the page shows: a copy older than three polls of its mode is stale
export const ffStale = (age, hot) => age > 3 * ffTtl(hot);
