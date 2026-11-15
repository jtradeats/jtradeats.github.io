// GET /sectors: the 11 SPDR sector ETFs plus SPY as the reference (plan P4).
// The list lives in worker/config/symbols.json (items with "set": "sectors"), so there is still one item list; index.js passes it in.
// One Yahoo chart call per symbol: 12 subrequests, 24 if every first host fails (limit 50). No substitute source:
// a failed item shows STALE with its last good value (principle 1); KV keeps the last good snapshot across cold starts.
import { chart, quote, makeRoute } from './route.js';

async function fetchOne(spec) {
  const hop = spec.chain.find(h => h[0] === 'yahoo');
  if (!hop) throw new Error('no yahoo entry in chain');
  const sym = hop[1];
  const m = (await chart(sym, '1d', '1d')).meta;       // same call and fields as the main tape's ETFs, so the two never disagree
  const prev = m.chartPreviousClose ?? m.previousClose;
  const t = m.regularMarketTime;
  return { src: `yahoo:${sym}`, f: Date.now(), ...quote(m.regularMarketPrice, prev, t ? t * 1000 : null) };
}

export function makeSectors(items) {
  return makeRoute({ name: 'sectors', kvKey: 'sectors:snapshot', specs: items.filter(i => i.set === 'sectors'), fetchOne });
}
