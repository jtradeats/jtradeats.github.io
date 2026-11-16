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
- `src/official.js`: actuals computed from FRED series for claims, payrolls, unemployment, earnings, CPI, PPI, retail sales (headline and ex-autos), core PCE, GDP, JOLTS, ADP, new and existing home sales and the Philadelphia Fed index (`SPEC` lists the rows; ISM, S&P Global, Chicago PMI, Conference Board, EIA crude, durable goods, Treasury auctions and the Fed decision stay typed in `results.json`). **Needs the secret `FRED_KEY`** (free key from fred.stlouisfed.org > My Account > API Keys; Cloudflare dashboard > Settings > Variables and Secrets, type Secret, then redeploy): the Worker then reads FRED's API. Without it the keyless CSV is tried, and FRED refuses that from Cloudflare (HTTP 520). The same secret also enables the BLS-date fallback in the schedule sync. `/calendar?debug=1` shows `official.via` (`api` or `csv`) and any error. Add rows to `SPEC` to cover more releases. Tests: `node --test worker/test/*.test.mjs`.
- Providers (all optional): Fair Economy feed (forecast and previous, often 429 from Cloudflare) and **Financial Modeling Prep** (forecast, previous, actual). For FMP add the secret `FMP_KEY` (Cloudflare dashboard, Settings, Variables and Secrets, type Secret) and redeploy.
- `GET /calendar?debug=1` shows each provider's raw sample and `unmatched` titles. `/health` shows `calendar.fmp`.
- Tests: `node --test worker/test/calendar.test.mjs`.
- KV writes (worst case a day): market 480, calendar feed 48, DeItaone snapshot 96, FinancialJuice snapshot 96, FMP at most 144: about 864 of 1,000. (Plan D79's 5-minute market snapshot, not built yet, would take market to 288.)

## Schedule sync (plan P2, P3)
- `src/schedule_sync.js`: pure code for the nightly sync (parsers, merge, change log, status). `test/schedule_sync.test.mjs` tests it: `node --test test/schedule_sync.test.mjs`.
- Three daily Cron Triggers (`wrangler.toml`, UTC 09:20 / 09:30 / 09:40): **BLS** release pages (CPI, jobs report, PPI, JOLTS), **Treasury** (TreasuryDirect announced auctions plus Treasury's tentative auction schedule), **provider** look-ahead (FMP and Fair Economy dates for PMIs, ADP, retail sales and similar). Each source is its own run, so each has its own CPU budget.
- The result lives in KV (`schedule:synced`) and is merged over `config/schedule.json` on every load. `schedule.json` stays the baseline and the fallback; nothing is written back to it.
- Lines carry a tier in `v`: omitted = agency page, `tent` = agency, tentative (Treasury), `prov` = calendar provider, `ref`, `rule`, `check` as before. A synced line replaces a line of equal or lower tier (check < rule < ref = prov < tent < agency).
- `config/indicators.json`: each kind has a `sync` setting (`bls`, `treasury`, `provider`). Kinds without it (Fed meetings, minutes, speeches, GDP, holidays) stay file-driven.
- `GET /sync` shows the state (read only); `/sync?debug=1` adds the samples kept when a source could not be read. `/health.sync` and `/calendar` carry a short status too. If a source is overdue (36 h) the next `/calendar` request starts it in the background.
- No new secret. `FMP_KEY` (already described above) switches the provider look-ahead on beyond the Fair Economy files.
## Wire actuals (plan P8.20, D117)
- `src/wire.js`: pure code. Reads the FinancialJuice posts (`feed.js` window) and fills a **blank** actual, forecast or previous with the wire's number, tagged `FJ` (a small "fj" mark on the page). Typed numbers (`results.json`) and provider numbers are never overwritten. Tests: `node --test test/wire.test.mjs` (real post wording from 16 Nov is in the test file).
- A post has no reference period, so it is matched to the row by time: post time from 30 s before to 45 min after the release. A post about last month's release never fills this month's row. A number outside the row's bounds, or in the wrong unit, is rejected and listed as `wire_rejected`.
- `src/official.js`: when FRED later returns the number for a row the wire filled, it **confirms** it (tag becomes `FRED`) or **corrects** it (the row shows FRED's number, keeps the wire's in `wfix`, is flagged `!`, and the page shows a "CORRECTED" alert). The wire's "previous" is replaced by FRED's. Rows FRED does not cover (ISM, S&P Global, Chicago PMI, Conference Board, EIA crude, auctions, the Fed decision) keep the `FJ` tag until a typed number replaces them.
- `src/feed.js`: one new export, `feedWindow`, a read-only view of a channel's window (with an optional poll).
- `src/index.js`: `/calendar` polls Telegram for FinancialJuice only from 2 minutes before to 40 minutes after a release the wire covers (the usual 10 s reuse and back-off apply), and otherwise just reads the window. The numbers are kept in a memo (`wire:actuals` in KV, written only when it changes, at most every 30 s: about 100 writes a month, well under the daily budget). `/calendar` carries a `wire` block (status, rows filled, how often the wire matched the official number, the wire's lag after the release); `?debug=1` adds the rows and the release-shaped posts that matched no rule (`unmatchedMacro`); `/health.calendar.wire` has the same summary.
- Rules marked `seen: 0` in `wire.js` use wording assumed from the same template (unemployment, earnings, CPI y/y, ISM, S&P Global, Chicago PMI, Conference Board and others). If the wording is wrong nothing matches and nothing is filled; send the posts listed under `unmatchedMacro` and they become real rules.
- `news.html`: the "fj" mark and tooltip, the release alert says "(FinancialJuice, unconfirmed)" when the figure is the wire's, a second alert says "CORRECTED" if the official number differs, and the footer line names the wire.
