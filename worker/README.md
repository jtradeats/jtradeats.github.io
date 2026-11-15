# Market Worker

- `src/index.js`: the Worker (same logic as the version deployed from the dashboard editor; only the item list moved).
- `config/symbols.json`: the item list. Edit here, not in the code.
- `src/feed.js`: the two Telegram wires from the public preview (plan 1.5, P1): DeItaone (`WalterBloomberg`) and FinancialJuice, served together at `/feed` (the DeItaone view at the top level, FinancialJuice under `fj`; posts that start with the red ❗ carry `hot: true`). `/feed?ch=FinancialJuice` returns one channel; `?debug=1` adds a markup sample when parsing fails. Channels are listed in `CHANNELS` at the top of the file (an unknown `ch` is a 400). Tests: `npm i -D html-rewriter-wasm`, then `node --test worker/test/feed.fj.test.mjs` (the older `feed.test.mjs`, if you have it, still applies).
- `wrangler.toml`: name must stay `market-dashboard` so the URL does not change.

## Switching to Git deploys (plan 2.1)
1. Put this `worker/` folder in the repo root next to `news.html` and push.
2. Create the KV namespace, paste its id into `wrangler.toml`, uncomment the block (plan 0.4).
3. Cloudflare dashboard > Workers & Pages > `market-dashboard` > Settings > Build: connect the GitHub repo, root directory `worker`, deploy command `npx wrangler deploy`. Labels may differ slightly; check the current Cloudflare docs.
4. After the first deploy open `/health`: expect `ok:true` and `kv:true`.

Imports from `../config/` stay inside `worker/` so the build works whichever way the root directory is handled.

## Calendar (plan v0.15)
- `config/schedule.json`: official release dates and times (ET). One line per release; it expands into the kind's rows. `v` tiers: official, `ref` (from the reference calendar screenshots, 14 Nov), `rule`, `check`.
- `config/indicators.json`: kinds, rows, provider title patterns, the hand-written "what to expect" families and the dated policy backdrop. Edit the backdrop when the Fed's stance changes.
- `config/results.json`: numbers typed by hand (actual, forecast, previous, revised flag). They win over the providers. Edit on GitHub; Cloudflare redeploys.
- `src/official.js`: actuals for claims, payrolls, unemployment, earnings and CPI computed from FRED series (no key). Add rows to `SPEC` to cover more releases. Tests: `node --test worker/test/*.test.mjs`.
- Providers (all optional): Fair Economy feed (forecast and previous, often 429 from Cloudflare) and **Financial Modeling Prep** (forecast, previous, actual). For FMP add the secret `FMP_KEY` (Cloudflare dashboard, Settings, Variables and Secrets, type Secret) and redeploy.
- `GET /calendar?debug=1` shows each provider's raw sample and `unmatched` titles. `/health` shows `calendar.fmp`.
- Tests: `node --test worker/test/calendar.test.mjs`.
- KV writes (worst case a day): market 480, calendar feed 48, DeItaone snapshot 96, FinancialJuice snapshot 96, FMP at most 144: about 864 of 1,000. (Plan D79's 5-minute market snapshot, not built yet, would take market to 288.)
