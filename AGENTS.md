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
