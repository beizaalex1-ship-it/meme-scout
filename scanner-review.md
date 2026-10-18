# Item 2 review — not published

## Implemented
- Bonding-curve price and sampled blockchain activity are the primary market evidence; indexed prices/activity are labelled backups.
- Missing or stale mandatory market reads remain UNANALYZED, with retained dashboard records and no prediction or Telegram recommendation. Discovery results beyond the per-run cap are also retained.
- Source, measurement time, sampled trade coverage, unique buyers/sellers and missing fields accompany research. Indexed backups do not invent wallet counts, SOL flows or hourly volumes.
- Conditional coin claiming supports retries without claiming the same row twice.
- Telegram delivery requires PASS security, verified holders, COMPLETE wallet forensics, a verified active curve, complete trade-window coverage and the existing AI strong-setup benchmark of 70. Opportunity scoring and evidence caps are unchanged; their upgrade remains Item 3.
- Concurrent and retry RPC attempts check the shared allowance immediately before counting/sending. Budget-read errors fail closed; accounting pages through all saved runs; skipped methods are saved before resetting the guard.
- Reserve is conservatively 235 attempts per coin: (13 market + 2 holder + 32 wallet) × 5 possible attempts. Normal cost is at most 47 per analyzed coin plus discovery/account batches; actual usage varies with caching and transaction count. Discovery transaction lookups do not retry within the same scan.
- Outcome curve prices are fetched in batches under the scan lock/allowance, with indexed backup for missing/graduated curves. Original predictions remain untouched. Follow-ups explicitly describe present-time measurement, not historical exact-checkpoint prices.

## Evidence
- 99 automated tests passed, including paced concurrent spending, retry exhaustion, market failure/readiness, account ownership/discriminator checks, incomplete-wallet approval and retained/no-alert missing-market scan flow.
- Real read on PBNJ TIMW: 0.000000005423657185 SOL/token; estimated USD 0.000000551785632354; 84 successful and 2 failed curve transactions in the 5-minute signature window. Twelve parsed trades: 6 buys, 6 sells, 4 unique buyers and 4 unique sellers in that sample. Fourteen Helius attempts. Coverage incomplete, therefore not approval-eligible.
- Signed-in dashboard opened and Scan now was exercised without browser errors. The existing AI 402 pause prevented a new complete live scan; it was not resumed. No new observations or coin rows were manufactured for verification.

## Remaining limitations
- The shared allowance is per running process/scan, not a durable cross-worker atomic monthly reservation. The database lock expires after 240 seconds: a scan exceeding its lease or process termination before accounting can still undercount or overlap. Fixing that properly needs durable attempt reservations/lease ownership, not a safety claim based on this guard.
- Provider credits are estimated as one per standard request including retries; no provider billing balance or external usage is available. Standalone diagnostic calls are not scanner history entries (the live check used 14).
- Twelve trades are a bounded sample, not the full busy-market window; the example fails complete-coverage approval. SOL balance movements include fees/rent and should not be represented as exact executed notional.
- COMPLETE forensics covers the existing bounded investigation, not exhaustive lifetime wallet history. Security PASS covers existing mint/extension checks; approval additionally requires the verified active Pump.fun curve. Independent general honeypot/LP checks are not newly implemented.
- Existing scoring still relies on legacy hour-based rules; absent hour data is not a fabricated hour total. Wallet evidence caps and measured time-based scoring remain later items, unchanged here.
- Follow-ups remain tied to the existing five-minute scanner and do not guarantee exact checkpoint timing; paused scans do not collect outcomes. Graduated tokens still depend on indexed providers.
- The dashboard still displays the existing latest-50 coin/latest-25 prediction window; saved rows are retained, not deleted.
- Full new research readback and scheduled production verification remain blocked by the existing AI-credit pause and the user's no-publish requirement.