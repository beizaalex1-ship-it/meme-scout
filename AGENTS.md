<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Security verdicts are PASS/FAIL/UNVERIFIED; failed blockchain lookups must yield UNVERIFIED, never assumed defaults (prevents false safety claims).
- Wallet forensics (creator, early buyers, funding, snipers, bundles) run under a fixed per-token RPC call budget with a signature-keyed tx cache; keep analysis pure in forensics.ts and fetching in forensics.server.ts (testable, respects provider limits).
- Every RPC attempt is counted in rpcUsage and saved per scan in scan_runs; the per-run coin cap lives in scanner_state so it can be changed from the dashboard without a deploy.
- Predictions are frozen at detection (predictions table, DB trigger blocks UPDATE); outcomes live only in prediction_observations, collected before each scan from free DexScreener data. Why: no look-ahead bias, original calls stay auditable.
- Scanner tables are server-only (no anon/authenticated access); the dashboard reads them via server functions. Free market APIs go through http.ts (pacing, bounded jittered retries, 60s host cooldown, 30s cache).
- Discovery: GeckoTerminal first; Helius launch-account fallback (discovery.ts pure, discovery.server.ts fetch) only when GeckoTerminal's first page fails, capped by scanner_state per-scan limit; processed signatures stored in helius_launches. A shared per-scan Helius budget guard in rpc() (rpcBudget = monthly budget minus this month's counted calls) blocks every Helius call once spent; discovery and coin count leave a per-coin reserve for safety/wallet checks; blocked checks surface as UNVERIFIED. Why: free first, budget never silently exceeded.
- Dashboard and all scanner server functions require sign-in plus admin role (requireAdmin in src/lib/admin-middleware.ts); public signup is disabled; the cron endpoint stays on LOVABLE_CRON_SECRET. Why: private tool, server-side enforcement.
- Live market fetching stays in market.server.ts, decoding/readiness in onchain.ts, and delivery eligibility in approval.ts; store sourced marketData with every result and preserve retryable discoveries as unanalyzed rows. Why: missing indexed data must not erase coins or manufacture verified prices, hour totals or approvals.
- RPC checks and attempt increments have no await between them; reserve worst-case activity/holder/forensics retries before optional discovery. Why: parallel callers must not reuse the same remaining credit.
