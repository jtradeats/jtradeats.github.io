# Market Worker

- `src/index.js`: the Worker (same logic as the version deployed from the dashboard editor; only the item list moved).
- `config/symbols.json`: the item list. Edit here, not in the code.
- `wrangler.toml`: name must stay `market-dashboard` so the URL does not change.

## Switching to Git deploys (plan 2.1)
1. Put this `worker/` folder in the repo root next to `news.html` and push.
2. Create the KV namespace, paste its id into `wrangler.toml`, uncomment the block (plan 0.4).
3. Cloudflare dashboard > Workers & Pages > `market-dashboard` > Settings > Build: connect the GitHub repo, root directory `worker`, deploy command `npx wrangler deploy`. Labels may differ slightly; check the current Cloudflare docs.
4. After the first deploy open `/health`: expect `ok:true` and `kv:true`.

Imports from `../config/` stay inside `worker/` so the build works whichever way the root directory is handled.
