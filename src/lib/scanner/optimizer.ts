// Credits optimizer: decides which coins get the expensive checks (holders + wallet forensics + AI).
import type { SecurityReport } from "./rules";

export type PlanInput<T> = { item: T; quality: number; security: SecurityReport };

export type Plan<T> = {
  /** verified PASS coins, best first, capped */
  analyze: T[];
  /** verified FAIL: rejected now, no further credits spent */
  earlyReject: T[];
  /** Helius check failed (UNVERIFIED): skipped this run, may be retried next run */
  skippedUnverified: T[];
  /** PASS coins beyond the cap */
  overCap: T[];
};

export function planCandidates<T>(cands: PlanInput<T>[], maxCoins: number): Plan<T> {
  const pass = cands.filter((c) => c.security.verdict === "PASS").sort((a, b) => b.quality - a.quality);
  return {
    analyze: pass.slice(0, maxCoins).map((c) => c.item),
    overCap: pass.slice(maxCoins).map((c) => c.item),
    earlyReject: cands.filter((c) => c.security.verdict === "FAIL").map((c) => c.item),
    skippedUnverified: cands.filter((c) => c.security.verdict === "UNVERIFIED").map((c) => c.item),
  };
}
