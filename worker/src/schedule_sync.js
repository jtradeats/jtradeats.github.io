// Schedule sync (plan P2 and P3, D76 to D96): keeps the release schedule current without anyone typing a date.
// Nightly the Worker reads three things and stores what it found in KV (key "schedule:sync"); at request time that overlay is merged over
// worker/config/schedule.json, which stays the baseline and the safety net.
//   1. BLS      the agency's own release pages (CPI, jobs report, PPI, JOLTS): official dates through the end of next year.
//   2. Treasury TreasuryDirect's announced-auctions list (exact, about a week ahead) and Treasury's tentative auction schedule (six months ahead).
//   3. Provider the dates in the calendar providers (FMP, Fair Economy) for the releases no agency page covers here (PMIs, ADP, retail, claims...).
// Pure functions: no fetch, no KV, no globals. index.js downloads and stores; the tests run the same code.
import { holidays, etParts, etToMs, candidates } from './schedule.js';

export const SYNC_KEY = 'schedule:synced';
export const SYNC_SOURCES = ['bls', 'treasury', 'provider'];
export const SYNC_RETRY = 6 * 3600e3;   // a source that failed is tried again after this long (a blocked source is not hammered)
export const SYNC_STALE = 36 * 3600e3;   // a source not refreshed for this long is overdue: the lazy safety net runs it and the schedule check says so (D77)
const DAY = 864e5;
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONC = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONF = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// How much a date can be trusted, by the tier written in schedule.json's "v": check < rule < ref = prov < tent < official (v omitted).
// A synced line replaces a line of the same release only when its tier is at least as high; at equal tier the newer one wins.
export const rank = v => (v === 'check' ? 0 : v === 'rule' ? 1 : v === 'ref' || v === 'prov' ? 2 : v === 'tent' ? 3 : 4);

const isoOf = dt => dt.toISOString().slice(0, 10);
const dowOf = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
export const addDays = (iso, n) => isoOf(new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY));
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const weekStart = iso => addDays(iso, -((dowOf(iso) + 6) % 7));

// ---- identity of a release: which line of schedule.json a synced line is about ----
// Monthly releases with a period ("Oct") are keyed by the reference month, so a date that moves (10 Dec to 11 Dec) is still the same release.
// Weekly releases are keyed by the Monday of their week (Thursday claims move to Wednesday in holiday weeks). Anything else by its month.
export function refYM(p, d) {
  const m = MON.indexOf(String(p || '').slice(0, 3).toLowerCase());
  if (m < 0 || !/^\d{4}-\d\d/.test(d || '')) return null;
  const [y, mo] = d.split('-').map(Number);
  return `${m + 1 > mo ? y - 1 : y}-${String(m + 1).padStart(2, '0')}`;
}
export function lineKey(r, IND) {
  const per = (IND.kinds[r.k] || {}).per;
  if (per === 'w') return `${r.k}|w|${weekStart(r.d)}`;
  const ym = per === 'm' ? refYM(r.p, r.d) : null;
  return ym ? `${r.k}|r|${ym}` : `${r.k}|d|${r.d.slice(0, 7)}`;
}

// ---- is a synced line plausible? Same rules the audit applies, but applied before the line is accepted, so one bad parse cannot poison the calendar ----
const HOL = new Map();
const holName = iso => { const y = +iso.slice(0, 4); if (!HOL.has(y)) HOL.set(y, holidays(y)); return HOL.get(y).get(iso); };
export function checkLine(l, IND) {
  const ind = IND.kinds[l.k];
  if (!ind) return 'unknown release kind';
  if (!/^\d{4}-\d\d-\d\d$/.test(l.d || '') || isNaN(Date.parse(l.d + 'T00:00:00Z'))) return 'not a valid date';
  if (etToMs(`${l.d}T${l.t}`) == null) return 'not a valid time';
  if (!ind.free) {
    const w = dowOf(l.d);
    if (w === 0 || w === 6) return 'a weekend';
    const h = holName(l.d);
    if (h) return `a federal holiday (${h})`;
    if (![ind.time].concat(ind.alt || []).includes(l.t)) return `at ${l.t} ET, not a usual ${l.k} time`;
  }
  return null;
}

// ================= 1. BLS =================
export const BLS_URL = page => `https://www.bls.gov/schedule/news_release/${page}.htm`;
const bls24 = (h, m, ap) => `${String((+h % 12) + (/^p/i.test(ap) ? 12 : 0)).padStart(2, '0')}:${m}`;

// The schedule page is a table "Reference Month | Release Date | Release Time": "October 2026 | Nov. 10, 2026 | 08:30 AM".
// Tags are stripped first and the text is matched, so a change of table markup does not matter; a change of wording would (and says so: zero rows).
export function parseBls(html) {
  let s = String(html || '');
  const i = s.search(/Reference\s+Month/i);
  if (i >= 0) s = s.slice(i);
  const j = s.search(/<\/table>/i);
  if (j >= 0) s = s.slice(0, j);
  s = s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
  const rx = new RegExp(`\\b(${MONF.join('|')})\\s+(\\d{4})\\s+(${MON.join('|')})[a-z]*\\.?\\s+(\\d{1,2}),\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})\\s*([AP])\\.?M`, 'gi');
  const out = [];
  let m;
  while ((m = rx.exec(s))) {
    const refM = MONF.indexOf(m[1].toLowerCase()), relM = MON.indexOf(m[3].toLowerCase().slice(0, 3));
    out.push({ p: MONC[refM], d: `${m[5]}-${String(relM + 1).padStart(2, '0')}-${String(+m[4]).padStart(2, '0')}`, t: bls24(m[6], m[7], m[8]) });
  }
  return out;
}

export async function runBls({ get, IND, now, prev }) {
  const today = etParts(now).iso, kinds = Object.entries(IND.kinds).filter(([, v]) => v.sync && v.sync.src === 'bls');
  const out = { at: now, day: today, ok: false, err: null, k: { ...((prev && prev.k) || {}) } }, errs = [];
  await Promise.all(kinds.map(async ([k, ind]) => {
    try {
      const rows = parseBls(await get(BLS_URL(ind.sync.page)));
      if (!rows.length) throw new Error('no release rows found on the page (the layout may have changed)');
      const lines = [], rejected = [], seen = [];
      for (const r of rows) {
        const l = { d: r.d, t: r.t, k, p: r.p };
        seen.push(lineKey(l, IND));
        if (r.d < today) continue;
        const why = checkLine(l, IND);
        if (why) rejected.push({ d: l.d, t: l.t, p: l.p, why }); else lines.push(l);
      }
      const ds = rows.map(r => r.d).sort();
      // the page lists every future release, so a line of schedule.json that is no longer on it has been cancelled; only trusted when the page looks complete
      out.k[k] = { at: now, ok: true, err: null, n: lines.length, lines, seen, rejected, prune: rows.length >= 8 ? [ds[0], ds[ds.length - 1], 4] : null };
    } catch (e) {
      errs.push(`${ind.name || k}: ${e.message}`);
      out.k[k] = { ...(out.k[k] || { lines: [], seen: [] }), ok: false, err: String(e.message).slice(0, 160), failAt: now };
    }
  }));
  out.ok = Object.values(out.k).some(x => x.ok && x.at === now);
  out.err = errs.length ? errs.join(' | ').slice(0, 300) : null;
  return out;
}

// ---- 1b. FRED release calendar: the stand-in for the BLS pages when bls.gov refuses the Worker (it answered HTTP 403, 15 Nov 2026) ----
// FRED (St. Louis Fed) lists the release dates of CPI, PPI, the jobs report and JOLTS, including future ones, and relays BLS's own schedule.
// It has the date only: the reference month and the time of day are taken from the line of schedule.json it matches, so FRED can confirm or move
// a date but never add one. A date that moves by more than 7 days is refused and reported. Needs a free API key (secret FRED_KEY).
export const FRED_URL = (key, today) => `https://api.stlouisfed.org/fred/releases/dates?api_key=${encodeURIComponent(key)}&file_type=json&include_release_dates_with_no_data=true&realtime_start=${today}&realtime_end=9999-12-31&order_by=release_date&sort_order=asc&limit=1000`;
export const FRED_NAMES = { cpi: /^consumer price index$/i, ppi: /^producer price index$/i, nfp: /^employment situation$/i, jolts: /^job openings and labor turnover survey$/i };
export function parseFredDates(json) {
  const rows = (json && json.release_dates) || [];
  return rows.map(r => ({ name: String(r.release_name || '').trim()   /* exact name: variants such as "(data not included in press release)" are different releases */, d: String(r.date || '') })).filter(r => r.name && /^\d{4}-\d\d-\d\d$/.test(r.d));
}
export async function runFred({ get, key, kinds, IND, base, now, prev }) {
  const today = etParts(now).iso, k = {}, errs = [];
  const fail = (kind, msg) => { errs.push(`${(IND.kinds[kind] || {}).name || kind}: ${msg}`); k[kind] = { ...((prev && prev.k && prev.k[kind]) || { lines: [], seen: [] }), ok: false, err: String(msg).slice(0, 160), failAt: now, via: 'fred' }; };
  let rows = null;
  try { rows = parseFredDates(JSON.parse(await get(FRED_URL(key, today)))); if (!rows.length) throw new Error('FRED returned no release dates'); }
  catch (e) { const m = String(e.message).replace(/api_key=[^&\s]*/gi, 'api_key=***'); for (const kind of kinds) fail(kind, `FRED: ${m}`); return { k, err: errs.join(' | ').slice(0, 300) }; }
  for (const kind of kinds) {
    const rx = FRED_NAMES[kind];
    if (!rx) { fail(kind, 'no FRED release is configured for this kind'); continue; }
    const dates = [...new Set(rows.filter(r => rx.test(r.name) && r.d >= today).map(r => r.d))].sort();
    if (!dates.length) { fail(kind, 'FRED lists no upcoming dates for this release'); continue; }
    const mine = base.filter(r => r.k === kind && r.d >= today).sort((a, b) => (a.d < b.d ? -1 : 1));
    const lines = [], rejected = [], used = new Set();
    for (const b of mine) {   // each line of the file takes the nearest unused FRED date within 20 days
      let best = null;
      for (const f of dates) if (!used.has(f)) { const g = Math.abs(daysBetween(b.d, f)); if (g <= 20 && (!best || g < best.g)) best = { f, g }; }
      if (!best) continue;
      used.add(best.f);
      const l = { d: best.f, t: b.t, k: kind, p: b.p };
      if (best.g > 7) { rejected.push({ d: l.d, t: l.t, p: l.p, why: `FRED lists ${l.d} but the schedule says ${b.d}, which is too far apart to follow without a check` }); continue; }
      const why = checkLine(l, IND);
      if (why) rejected.push({ d: l.d, t: l.t, p: l.p, why }); else lines.push(l);
    }
    k[kind] = { at: now, ok: true, err: null, n: lines.length, lines, seen: [], rejected, prune: null, via: 'fred' };
  }
  return { k, err: errs.length ? errs.join(' | ').slice(0, 300) : null };
}

// ================= 2. Treasury =================
export const TD_URL = type => `https://www.treasurydirect.gov/TA_WS/securities/announced?format=json&type=${type}`;
// Treasury's tentative auction schedule: one file per refunding quarter (Q1 Feb-Apr, Q2 May-Jul, Q3 Aug-Oct, Q4 Nov-Jan), published on the refunding day.
export const refundingQuarter = iso => {
  const [y, m] = iso.split('-').map(Number);
  return m === 1 ? { q: 4, y: y - 1 } : { q: m <= 4 ? 1 : m <= 7 ? 2 : m <= 10 ? 3 : 4, y };
};
export const nextQuarter = ({ q, y }) => (q === 4 ? { q: 1, y: y + 1 } : { q: q + 1, y });
export const prevQuarter = ({ q, y }) => (q === 1 ? { q: 4, y: y - 1 } : { q: q - 1, y });
export const tentUrl = ({ q, y }) => `https://home.treasury.gov/system/files/221/TentativeAuctionScheduleQ${q}${y}.xml`;

// "10-Year Note" (also the 9-year reopenings) and "30-Year Bond" (also 29-year reopenings). TIPS, FRNs, bills and the other terms are ignored.
export function classifyTreasury(text) {
  const s = String(text || '');
  if (/TIPS|FRN|Floating|\bBills?\b|Cash Management|\bCMB\b/i.test(s)) return null;
  if (/(?<!\d)(?:9|10)\s?-?\s?Year\b/i.test(s) && /\bNotes?\b/i.test(s)) return 'auc10';
  if (/(?<!\d)(?:29|30)\s?-?\s?Year\b/i.test(s) && /\bBonds?\b/i.test(s)) return 'auc30';
  return null;
}

// '2026-12-08', '2026-12-08T00:00:00', '12/08/2026', 'Tuesday, December 08, 2026', 'December 8, 2026', '8-Dec-2026' -> 'YYYY-MM-DD' or null
export function parseDateLoose(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d\d)-(\d\d)(?:$|[T\s])/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if ((m = new RegExp(`(?:^|\\s)(${MONF.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i').exec(s))) return `${m[3]}-${String(MONF.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if ((m = new RegExp(`^(\\d{1,2})[- ](${MON.join('|')})[a-z]*[- ,]+(\\d{4})$`, 'i').exec(s))) return `${m[3]}-${String(MON.indexOf(m[2].toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const looksDate = v => parseDateLoose(v) != null;

// TreasuryDirect JSON: [{ securityType: "Note", securityTerm: "9-Year 10-Month", announcementDate, auctionDate: "2026-12-08T00:00:00", ... }]
export function parseTreasuryJson(arr, today) {
  const out = [];
  for (const o of Array.isArray(arr) ? arr : []) {
    // TIPS reopenings carry the term "9-Year 11-Month", which looks like a 10-year note: the flags and every text field are checked for them
    const flagged = [o.tips, o.inflationIndexSecurity, o.floatingRate].some(v => /^(yes|y|true)$/i.test(String(v ?? ''))) || Object.values(o).some(v => typeof v === 'string' && /TIPS|Inflation|Floating|\bFRN\b/i.test(v));
    const k = flagged ? null : classifyTreasury(`${o.securityType || ''} ${o.securityTerm || ''}`), d = parseDateLoose(o.auctionDate);
    if (k && d && d >= today) out.push({ k, d, s: `${o.securityType || ''} ${o.securityTerm || ''}`.trim() });
  }
  return out;
}

const xmlText = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch (_) { return m; } }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()] ?? m;
}).trim();

// Records out of Treasury's tentative-auction XML. The real layout (read from the Q3 2026 file) is a flat list of
//   <AuctionCalendarDate><SecurityTermWeekYear>10-Year</SecurityTermWeekYear><SecurityType>NOTE</SecurityType><ReOpeningIndicator>Y</ReOpeningIndicator>
//   <TIPS>Y</TIPS><FloatingRate>N</FloatingRate><AnnouncementDate>..</AnnouncementDate><AuctionDate>2026-11-19</AuctionDate><SettlementDate>..</SettlementDate></AuctionCalendarDate>
// A TIPS or floating-rate security is NOT named in any text: it is a "10-Year" "NOTE" with <TIPS>Y</TIPS>, so the flag must be read (that was the 19 Nov "move").
// Holiday records (<HolidayName>, <HolidayDate>) have no auction date and are skipped. Three readings, first one that finds auctions wins; the other two cover other layouts:
//   a) leaf elements: the element that repeats most (earliest on a tie) starts a record (the real layout)
//   b) attributes: <Auction type="NOTE" term="10-Year" auctionDate="2026-12-08"/>
//   c) plain text in the PDF's row order: "10-Year NOTE R Thursday, December 03, 2026 Tuesday, December 08, 2026 Tuesday, December 15, 2026"
const FLAG_KEY = /tips|float|frn|inflation/i, FLAG_ON = /^(y|yes|true|1)$/i;
function rowsFromRecords(recs, today) {
  const out = [];
  for (const rec of recs) {
    const ent = Object.entries(rec);
    if (ent.some(([key, v]) => FLAG_KEY.test(key) && FLAG_ON.test(String(v).trim()))) continue;   // TIPS / floating-rate: never the plain note or bond
    const dk =ent.find(([key, v]) => /auction/i.test(key) && /date|dt/i.test(key) && !/announce|issue|settle|matur|dated|original/i.test(key) && looksDate(v));
    if (!dk) continue;
    const k = classifyTreasury(ent.filter(([, v]) => !looksDate(v)).map(([, v]) => v).join(' ')), d = parseDateLoose(dk[1]);
    if (k && d && d >= today) out.push({ k, d });
  }
  return out;
}
const RELEVANT = /(?<!\d)(?:9|10|29|30)\s?-?\s?Year/i;   // the only terms we read; everything else in the file is skipped without being parsed (10 ms CPU limit)
const leaves = str => { const out = [], rx = /<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g; let m; while ((m = rx.exec(str))) out.push([m[1], m[2]]); return out; };
export function parseTentative(xml, today) {
  const s = String(xml || '');
  let rows = [], m;
  // a) leaf elements. The record-starting element is found in the head of the file (the one that repeats most, earliest on a tie); the rest is cut at it
  //    and only the pieces that mention a 9/10/29/30-year term are parsed.
  const head = leaves(s.slice(0, 16000)), count = new Map(), first = new Map();
  head.forEach(([t], i) => { count.set(t, (count.get(t) || 0) + 1); if (!first.has(t)) first.set(t, i); });
  let delim = null;
  for (const [t, c] of count) if (c >= 3 && (delim === null || c > count.get(delim) || (c === count.get(delim) && first.get(t) < first.get(delim)))) delim = t;
  if (delim) {
    const parts = s.split('<' + delim), recs = [];
    for (let i = 1; i < parts.length; i++) {
      const chunk = '<' + delim + parts[i];
      if (!RELEVANT.test(chunk)) continue;
      const rec = {};
      for (const [t, v] of leaves(chunk)) if (!(t in rec)) rec[t] = xmlText(v);
      recs.push(rec);
    }
    rows = rowsFromRecords(recs, today);
  }
  // b) attributes: <Auction type="NOTE" term="10-Year" auctionDate="2026-12-08"/>
  if (!rows.length) {
    const recs = [];
    for (const piece of s.split('<')) {
      if (!RELEVANT.test(piece)) continue;
      const rec = {}, at = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g, head2 = piece.slice(0, piece.indexOf('>') + 1 || piece.length);
      let a, n = 0;
      while ((a = at.exec(head2))) { rec[a[1]] = xmlText(a[2]); n++; }
      if (n >= 3) recs.push(rec);
    }
    rows = rowsFromRecords(recs, today);
  }
  // c) plain text in the PDF's row order: "10-Year NOTE R Thursday, December 03, 2026 Tuesday, December 08, 2026 Tuesday, December 15, 2026"
  if (!rows.length) {
    const t = s.slice(0, 400000).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const W = `(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs)?|Fri|Sat|Sun)[a-z]*,?\\s+(?:${MONF.join('|')})\\s+\\d{1,2},?\\s+\\d{4}`;
    const rt = new RegExp(`(\\d+-Year(?:\\s+\\d+-Month)?\\s+(?:NOTE|BOND|TIPS|FRN)\\b(?:\\s+R\\b)?)\\s+(${W})\\s+(${W})`, 'gi');
    while ((m = rt.exec(t))) {
      const k = classifyTreasury(m[1]), d = parseDateLoose(m[3]);
      if (k && d && d >= today) rows.push({ k, d });
    }
  }
  return rows;
}

export async function runTreasury({ get, IND, now, prev }) {
  const today = etParts(now).iso, kinds = Object.entries(IND.kinds).filter(([, v]) => v.sync && v.sync.src === 'treasury');
  const out = { at: now, day: today, ok: false, err: null, k: {}, debug: null };
  const errs = [], ann = [], tent = [], files = [];
  let annOk = false, tentOk = false;
  // announced: exact dates, about a week ahead
  await Promise.all(['Note', 'Bond'].map(async type => {
    try { ann.push(...parseTreasuryJson(JSON.parse(await get(TD_URL(type))), today)); annOk = true; }
    catch (e) { errs.push(`announced ${type}s: ${e.message}`); }
  }));
  // tentative: six months ahead. This quarter's file, next quarter's (exists only after the refunding), and the previous one when this one is not out yet
  const cur = refundingQuarter(today), tryOrder = [cur, nextQuarter(cur)];
  let sample = null, got = 0;
  const readQ = async q => {
    try {
      const xml = await get(tentUrl(q));
      const rows = parseTentative(xml, today);
      if (!rows.length) { sample = String(xml).slice(0, 600); errs.push(`tentative schedule Q${q.q} ${q.y}: no 10-year or 30-year auctions found (the file layout may differ)`); return; }
      got++; tentOk = true; files.push(`Q${q.q}${q.y}`); tent.push(...rows);
    } catch (e) { if (!/HTTP 404/.test(e.message)) errs.push(`tentative schedule Q${q.q} ${q.y}: ${e.message}`); }
  };
  await readQ(tryOrder[0]);
  await readQ(tryOrder[1]);
  if (!got) await readQ(prevQuarter(cur));
  out.debug = { ...(sample ? { tentativeSample: sample } : {}), announced: ann.map(r => `${r.d} ${r.k} (${r.s || '?'})`).slice(0, 12) };
  for (const [k, ind] of kinds) {
    const old = (prev && prev.k && prev.k[k]) || { lines: [] }, byKey = new Map();
    // tentative first, announced over it; if a part failed, its previous lines stay (tentative ones are never dropped on a failed download)
    const tl = tentOk ? tent.filter(r => r.k === k) : (old.lines || []).filter(l => l.v === 'tent');
    const lines = [], rejected = [], seen = [], clash = new Set();
    // there is one 10-year and one 30-year auction a month: two different dates in one month from the same list cannot both be right, so neither is applied (and it is reported)
    const put = (l, tag) => { const key = lineKey(l, IND), cur = byKey.get(key); if (cur && cur.tag === tag && cur.d !== l.d) { clash.add(key); rejected.push({ d: l.d, why: `Treasury lists two ${ind.name || k} dates in one month (${cur.d} and ${l.d}); neither is applied` }); return; } byKey.set(key, { ...l, tag }); };
    for (const r of tl) put({ d: r.d, t: ind.time, k, v: 'tent', n: 'Tentative date from Treasury’s refunding schedule. Treasury confirms it about a week ahead.' }, 't');
    const al = annOk ? ann.filter(r => r.k === k) : (old.lines || []).filter(l => !l.v && l.d >= today);
    for (const r of al) put({ d: r.d, t: ind.time, k }, 'a');
    for (const key of clash) byKey.delete(key);
    for (const v of byKey.values()) delete v.tag;
    for (const l of byKey.values()) { seen.push(lineKey(l, IND)); const why = checkLine(l, IND); if (why) rejected.push({ d: l.d, why }); else lines.push(l); }
    lines.sort((a, b) => (a.d < b.d ? -1 : 1));
    const td = tl.map(r => r.d).sort();
    // the tentative schedule covers every 10-year and 30-year auction of the quarter: a line of schedule.json inside that window and not in the file is not trusted any more
    const prune = tentOk && td.length >= 3 ? [td[0], td[td.length - 1], 3] : (tentOk ? null : (old.prune || null));
    out.k[k] = { at: now, ok: annOk || tentOk, err: errs.length ? errs.join(' | ').slice(0, 200) : null, n: lines.length, lines, seen, rejected, prune,
      parts: { announced: annOk ? 'ok' : 'failed', tentative: tentOk ? 'ok' : 'failed', files } };
  }
  out.ok = annOk || tentOk;
  out.err = errs.length ? errs.join(' | ').slice(0, 300) : null;
  return out;
}

// ================= 3. Provider look-ahead =================
// feeds: [{ name, rows }] lowest priority first; rows are the normalised provider rows { t, title, ... } from schedule.js (normFair, normFmp).
const providerKind = (title, d, IND) => {
  const ks = [...new Set(candidates(IND, title).map(c => c.k))].filter(k => IND.kinds[k].sync && IND.kinds[k].sync.src === 'provider');
  if (ks.length <= 1) return ks[0] || null;
  if (ks.every(k => k.startsWith('spg_'))) {   // S&P Global: final PMIs come on business day 1 and 3, flash PMIs from about the 14th
    const t = title.toLowerCase();
    if (/flash/.test(t) || +d.slice(8, 10) >= 14) return 'spg_f';
    return /manufactur/.test(t) ? 'spg_m' : /service/.test(t) ? 'spg_s' : null;
  }
  return ks[0];
};
const periodOf = (title, k, d, IND) => {
  const ind = IND.kinds[k];
  if (ind.per !== 'm') return undefined;
  const m = new RegExp(`\\((${MON.join('|')})[a-z]*\\)`, 'i').exec(title);
  if (m) return MONC[MON.indexOf(m[1].toLowerCase().slice(0, 3))];
  const off = ind.sync && Number.isFinite(ind.sync.ref) ? ind.sync.ref : null;
  if (off == null) return undefined;
  return MONC[(((+d.slice(5, 7) - 1 + off) % 12) + 12) % 12];
};

export function providerLines(feeds, base, IND, now) {
  const today = etParts(now).iso, horizon = addDays(today, 40), byKey = new Map(), rejected = [];
  for (const f of feeds || []) for (const row of f.rows || []) {
    if (!row || !Number.isFinite(row.t)) continue;
    const e = etParts(row.t);
    if (e.iso < today || e.iso > horizon) continue;
    const k = providerKind(String(row.title || ''), e.iso, IND);
    if (!k) continue;
    const l = { d: e.iso, t: e.hm, k, v: 'prov', n: `Date from the ${f.name} calendar feed; no agency page was read for it.` };
    const p = periodOf(String(row.title || ''), k, e.iso, IND);
    if (p) l.p = p;
    const why = checkLine(l, IND);
    if (why) { rejected.push({ k, d: l.d, t: l.t, why, from: f.name }); continue; }
    const near = (base || []).filter(r => r.k === k && Math.abs(daysBetween(r.d, l.d)) <= 10).sort((a, b) => Math.abs(daysBetween(a.d, l.d)) - Math.abs(daysBetween(b.d, l.d)))[0];
    if (near && near.pre) l.pre = near.pre;
    byKey.set(lineKey(l, IND), l);
  }
  return { lines: [...byKey.values()], rejected };
}

export function runProvider({ feeds, base, IND, now, prev }) {
  const today = etParts(now).iso, ok = (feeds || []).some(f => (f.rows || []).length);
  const out = { at: now, day: today, ok, err: null, k: {}, feeds: (feeds || []).map(f => ({ name: f.name, n: (f.rows || []).length, err: f.err || null })) };
  if (!ok) {
    out.err = (feeds || []).map(f => `${f.name}: ${f.err || 'no rows'}`).join(' | ').slice(0, 300) || 'no provider is connected (add the FMP_KEY secret)';
    out.k = (prev && prev.k) || {};   // nothing came back: the last good look-ahead stays
    return out;
  }
  const r = providerLines(feeds, base, IND, now);
  for (const l of r.lines) (out.k[l.k] = out.k[l.k] || { at: now, ok: true, err: null, n: 0, lines: [], seen: [], rejected: [], prune: null });
  for (const l of r.lines) { const kr = out.k[l.k]; kr.lines.push(l); kr.n++; kr.seen.push(lineKey(l, IND)); }
  for (const x of r.rejected) (out.k[x.k] = out.k[x.k] || { at: now, ok: true, err: null, n: 0, lines: [], seen: [], rejected: [], prune: null }).rejected.push(x);
  return out;
}

// ================= merge, diff, status =================
// The effective schedule: schedule.json with the synced overlay applied. Pure and deterministic: the same inputs always give the same lines.
export function mergeSchedule(SCHED, rec, IND, today) {
  const base = (SCHED.releases || []).map(r => ({ ...r })), checked = { ...(SCHED.checked || {}) };
  const res = { releases: base, checked, issues: [], stats: { added: 0, updated: 0, removed: 0, confirmed: 0, rejected: 0 } };
  if (!rec || !rec.src) return res;
  const index = new Map(), dead = new Set();
  base.forEach((r, i) => { const k = lineKey(r, IND); if (!index.has(k)) index.set(k, i); });
  const note = (cur, l) => [cur.n && !/confirm/i.test(cur.n) ? cur.n : null, l.n].filter(Boolean).join(' ') || undefined;   // a "confirm this date" note is answered by the sync; other notes stay
  for (const name of ['provider', 'treasury', 'bls']) {
    const src = rec.src[name];
    if (!src) continue;
    for (const [kind, kr] of Object.entries(src.k || {})) {
      for (const x of kr.rejected || []) {
        if (res.issues.length < 8 && name !== 'provider') res.issues.push({ lvl: 'warn', code: 'sync_rejected', k: kind, d: x.d, msg: `${(IND.kinds[kind] || {}).name || kind}: the ${name === 'bls' ? 'BLS page' : 'Treasury schedule'} lists ${x.d}, which is ${x.why}. Kept the date already in the schedule.` });
        res.stats.rejected++;
      }
      for (const l of kr.lines || []) {
        const key = lineKey(l, IND), i = index.get(key);
        if (i == null) { base.push({ ...l }); index.set(key, base.length - 1); res.stats.added++; continue; }
        const cur = base[i];
        if (cur.d < today && l.d !== cur.d) continue;   // that release already happened: a later date in the same month is another release (e.g. a TIPS auction), not a move
        if (rank(l.v) < rank(cur.v)) { if (cur.d === l.d) res.stats.confirmed++; continue; }
        if (cur.d === l.d && cur.t === l.t && rank(l.v) === rank(cur.v)) continue;
        if (l.v === 'prov' && Math.abs(daysBetween(l.d, cur.d)) > 7) {   // a provider is allowed to correct a derived date, not to move it by weeks
          res.stats.rejected++;
          if (res.issues.length < 8) res.issues.push({ lvl: 'warn', code: 'sync_rejected', k: kind, d: l.d, msg: `${(IND.kinds[kind] || {}).name || kind}: the calendar feed says ${l.d}, the schedule says ${cur.d}. That is too far apart to take on trust; check the agency page.` });
          continue;
        }
        const out = { ...cur, d: l.d, t: l.t };
        if (l.p) out.p = l.p;
        if (l.v) out.v = l.v; else delete out.v;
        let n = note(cur, l);
        if (rank(cur.v) === 4 && !l.v && cur.d !== l.d) n = [n, `Date changed from ${cur.d} (schedule file) to ${l.d} by the ${kr.via === 'fred' ? 'FRED release calendar (it relays BLS)' : name === 'bls' ? 'BLS page' : 'Treasury schedule'}${src.day ? `, synced ${src.day}` : ''}.`].filter(Boolean).join(' ');   // D76
        if (n) out.n = n; else delete out.n;
        base[i] = out;
        res.stats.updated++;
      }
      if (kr.prune) {
        const [from, to, maxRank] = kr.prune, seen = new Set(kr.seen || []);
        base.forEach((r, i) => {
          if (dead.has(i) || r.k !== kind || r.d < today || r.d < from || r.d > to || rank(r.v) > maxRank) return;
          if (!seen.has(lineKey(r, IND))) { dead.add(i); res.stats.removed++; }
        });
      }
      if (kr.ok && (kr.lines || []).length && src.day) checked[kind] = src.day;   // "checked" is now the day a source last compared this release type
    }
  }
  res.releases = base.filter((_, i) => !dead.has(i));
  res.tiers = {};
  for (const r of res.releases) { const t = r.v || 'official'; res.tiers[t] = (res.tiers[t] || 0) + 1; }
  return res;
}

// What an overnight run changed, for the log shown in the schedule check: moved dates and times, cancelled releases, and releases that appeared soon.
export function diffSchedules(before, after, IND, today, aheadDays = 45) {
  const mb = new Map(before.releases.map(r => [lineKey(r, IND), r])), ma = new Map(after.releases.map(r => [lineKey(r, IND), r])), out = [];
  for (const [key, a] of ma) {
    const b = mb.get(key);
    if (!b) { if (a.d >= today && daysBetween(today, a.d) <= aheadDays) out.push({ type: 'added', k: a.k, p: a.p || null, to: { d: a.d, t: a.t }, v: a.v || 'official' }); }
    else if ((b.d !== a.d || b.t !== a.t) && (a.d >= today || b.d >= today)) out.push({ type: 'moved', k: a.k, p: a.p || null, from: { d: b.d, t: b.t }, to: { d: a.d, t: a.t }, v: a.v || 'official' });
  }
  for (const [key, b] of mb) if (!ma.has(key) && b.d >= today) out.push({ type: 'removed', k: b.k, p: b.p || null, from: { d: b.d, t: b.t } });
  return out;
}

export function syncIssues(rec, now, IND, haveProviderKey) {
  const out = [], STALE = SYNC_STALE, label = { bls: 'BLS', treasury: 'Treasury', provider: 'Calendar-feed look-ahead' };
  if (!rec || !rec.src) return [{ lvl: 'warn', code: 'sync_never', msg: 'The nightly schedule sync has not run yet. It runs every night (about 04:30 New York time) and on the first calendar request after a deploy; open /sync to see its state.' }];
  for (const name of ['bls', 'treasury', 'provider']) {
    const s = rec.src[name];
    if (name === 'provider' && !haveProviderKey && !(s && s.ok)) continue;   // no provider connected: expected, shown on /sync only
    if (!s) { out.push({ lvl: 'warn', code: 'sync_never', msg: `${label[name]} sync has not run yet.` }); continue; }
    if (!s.ok) out.push({ lvl: 'warn', code: 'sync_failed', msg: `${label[name]} sync failed: ${s.err || 'no data'}. The calendar keeps the last good dates${s.day ? ` (from ${s.day})` : ''}.` });
    else if (now - s.at > STALE) out.push({ lvl: 'warn', code: 'sync_stale', msg: `${label[name]} sync is overdue: it last succeeded ${Math.round((now - s.at) / 3600e3)} hours ago.` });
    if (s.ok) for (const [k, kr] of Object.entries(s.k || {})) if (!kr.ok && kr.err) out.push({ lvl: 'warn', code: 'sync_failed', k, msg: `${label[name]} sync could not read ${(IND.kinds[k] || {}).name || k}: ${kr.err}.` });
  }
  const today = etParts(now).iso;
  for (const c of rec.changes || []) {
    if (c.type !== 'moved' || now - c.at > 2 * DAY || daysBetween(today, c.to.d) > 45 || c.to.d < today) continue;
    out.push({ lvl: 'warn', code: 'sync_moved', k: c.k, d: c.to.d, msg: `${changeTitle(c, IND)} moved from ${c.from.d} ${c.from.t} to ${c.to.d} ${c.to.t} ET (${label[c.src] || c.src}).` });
  }
  return out;
}
export const changeTitle = (c, IND) => `${((IND.kinds[c.k] || {}).name) || c.k}${c.p ? ` (${c.p})` : ''}`;

// What /sync and the schedule check show: no lines, just the state of each source.
export function syncSummary(rec) {
  if (!rec || !rec.src) return { at: null, sources: {}, changes: [] };
  const sources = {};
  for (const [name, s] of Object.entries(rec.src)) {
    sources[name] = { at: s.at, day: s.day || null, ok: !!s.ok, err: s.err || null, feeds: s.feeds || undefined,
      kinds: Object.fromEntries(Object.entries(s.k || {}).map(([k, kr]) => [k, { ok: !!kr.ok, n: kr.n || 0, at: kr.at || null, err: kr.err || null, parts: kr.parts || undefined, rejected: (kr.rejected || []).length || undefined }])) };
  }
  return { at: rec.at || null, sources, changes: (rec.changes || []).slice(0, 20) };
}

// Which sources are overdue, oldest first: never run, older than SYNC_STALE, or failed more than SYNC_RETRY ago. Used by the lazy safety net (D77): the Worker runs at most one per request.
export function dueSources(rec, now, haveProviderKey) {
  return SYNC_SOURCES.filter(n => n !== 'provider' || haveProviderKey)
    .map(n => { const s = rec && rec.src && rec.src[n]; return { n, at: s ? s.at || 0 : 0, ok: !!(s && s.ok) }; })
    .filter(x => now - x.at > (x.ok || !x.at ? SYNC_STALE : SYNC_RETRY)).sort((x, y) => x.at - y.at).map(x => x.n);
}
