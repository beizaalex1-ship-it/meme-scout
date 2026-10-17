import { marketReadiness, type ActivitySummary, type Sourced } from "./onchain";
import type { SecurityReport, WalletReport } from "./rules";

/** Delivery eligibility only; the opportunity scoring formula is unchanged. */
export function approvalDecision(score: number, security: SecurityReport, wallet: WalletReport,
  market: { priceSol: Sourced<number>; priceUsd: Sourced<number>; activity: ActivitySummary | null; activityError?: string | null },
  curveVerified: boolean, nowMs: number) {
  const reasons: string[] = [];
  const ready = marketReadiness(market, nowMs);
  if (!ready.analyzable) reasons.push(ready.reason);
  if (security.verdict !== "PASS") reasons.push(`Security ${security.verdict}`);
  if (!curveVerified) reasons.push("Active Pump.fun curve not verified");
  if (!wallet.verified) reasons.push("Holder checks incomplete");
  if (wallet.forensics?.status !== "COMPLETE") reasons.push("Wallet checks incomplete");
  if (wallet.risk === "High Risk" || wallet.risk === "Unverified") reasons.push(`Wallet risk: ${wallet.risk}`);
  if (!market.activity?.sampleComplete) reasons.push("Trade window coverage incomplete");
  if (!Number.isFinite(score) || score < 70) reasons.push("Below the existing strong-opportunity benchmark (70)");
  return { approved: reasons.length === 0, reasons };
}