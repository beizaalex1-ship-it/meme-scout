// Deterministic agent logic (no AI). Shared by the scanner and tests.
import type { ForensicsReport } from "./forensics";

export const ALERT_MIN_SCORE = 1; // every analyzed, non-rug token is sent
export const MAX_LAUNCH_AGE_MIN = 10;
export const INSIDER_RED_FLAG_PCT = 30;
export const PUMP_GRADUATION_MCAP_USD = 69_000;

export type CoinHunterReport = {
  name: string | null;
  symbol: string | null;
  mint: string;
  mintTimestamp: string | null;
  creatorWallet: string | null;
  missing: string[];
};

export type MarketInput = {
  dexId: string;
  marketCapUsd: number | null;
  volumeM5: number;
  volumeH1: number;
  buysM5: number;
  sellsM5: number;
  buysH1: number;
  sellsH1: number;
  priceChangeH1: number | null;
};

export type MarketReport = {
  rating: "Low" | "Medium" | "High";
  marketCapUsd: number | null;
  bondingCurvePct: number;
  graduated: boolean;
  txnsH1: number;
  buySellRatioH1: number | null;
  volumeH1: number;
  flags: string[];
};

export function isGraduatedDex(dexId: string) {
  return dexId !== "pumpfun";
}

export function analyzeMarket(m: MarketInput): MarketReport {
  const graduated = isGraduatedDex(m.dexId);
  const bondingCurvePct = graduated
    ? 100
    : Math.min(99, Math.round(((m.marketCapUsd ?? 0) / PUMP_GRADUATION_MCAP_USD) * 100));
  const txnsH1 = m.buysH1 + m.sellsH1;
  const ratio = m.sellsH1 > 0 ? m.buysH1 / m.sellsH1 : m.buysH1 > 0 ? m.buysH1 : null;
  const flags: string[] = [];
  const avgTradeUsd = txnsH1 > 0 ? m.volumeH1 / txnsH1 : 0;

  if (txnsH1 < 30) flags.push("Dead launch: very few trades in the last hour");
  if (avgTradeUsd > 2_000 && txnsH1 < 100) flags.push("Possible wash trading: few, very large trades");
  if (ratio !== null && ratio > 0.95 && ratio < 1.05 && txnsH1 > 200)
    flags.push("Possible wash trading: buys and sells almost perfectly balanced");
  if (m.volumeM5 > m.volumeH1 * 0.6 && m.volumeH1 > 5_000) flags.push("Rapid volume surge in last 5 minutes");

  let rating: MarketReport["rating"] = "Low";
  const suspicious = flags.some((f) => f.startsWith("Dead") || f.startsWith("Possible wash"));
  if (!suspicious) {
    if (txnsH1 >= 500 && m.volumeH1 >= 50_000 && (ratio ?? 0) >= 1.1) rating = "High";
    else if (txnsH1 >= 100 && m.volumeH1 >= 10_000) rating = "Medium";
  }

  return {
    rating,
    marketCapUsd: m.marketCapUsd,
    bondingCurvePct,
    graduated,
    txnsH1,
    buySellRatioH1: ratio === null ? null : Math.round(ratio * 100) / 100,
    volumeH1: m.volumeH1,
    flags,
  };
}

export type WalletReport = {
  top10Pct: number | null;
  risk: "Safe" | "Moderate" | "High Risk" | "Unverified";
  verified: boolean;
  excludedAccounts: number;
  flags: string[];
  forensics?: ForensicsReport;
};

export type HolderAccount = { address: string; uiAmount: number; owner: string | null };

/**
 * Percent of supply per holder, largest first. Excludes the pool / bonding-curve account
 * (matched by token-account address or owner) and any extra program-owned owners given.
 * Returns null when supply is invalid or an account's owner could not be resolved
 * (an unresolved owner could be the pool, so the result would not be trustworthy).
 */
export function computeHolderPcts(
  accounts: HolderAccount[],
  supply: number,
  excludeOwners: string[],
): { pcts: number[]; excluded: number } | null {
  if (!Number.isFinite(supply) || supply <= 0) return null;
  if (accounts.some((a) => a.owner === null)) return null;
  const ex = new Set(excludeOwners);
  const kept = accounts.filter((a) => !ex.has(a.owner as string) && !ex.has(a.address));
  return {
    pcts: kept.map((a) => (a.uiAmount / supply) * 100).sort((a, b) => b - a),
    excluded: accounts.length - kept.length,
  };
}

/**
 * holders: percent of supply per holder, largest first, pool/bonding-curve excluded. null = lookup failed.
 * forensics: creator / early-buyer / funding analysis. Missing or incomplete forensics never yields "Safe".
 */
export function analyzeWallets(
  holders: { pcts: number[]; excluded: number } | null,
  unavailableReason?: string,
  forensics?: ForensicsReport,
): WalletReport {
  const flags: string[] = [];
  let risk: WalletReport["risk"] = "Unverified";
  let top10: number | null = null;
  if (!holders) {
    flags.push(`Holder data unavailable${unavailableReason ? `: ${unavailableReason}` : ""}`);
  } else {
    const holderPcts = holders.pcts;
    top10 = Math.round(holderPcts.slice(0, 10).reduce((a, b) => a + b, 0) * 10) / 10;
    if (holderPcts[0] !== undefined && holderPcts[0] > 10)
      flags.push(`Single wallet holds ${holderPcts[0].toFixed(1)}% of supply`);
    risk = "Safe";
    if (top10 > INSIDER_RED_FLAG_PCT) {
      risk = "High Risk";
      flags.push(`RED FLAG: top 10 holders own ${top10}% (over ${INSIDER_RED_FLAG_PCT}%)`);
    } else if (top10 > 20 || (holderPcts[0] ?? 0) > 10) {
      risk = "Moderate";
    }
  }

  if (!forensics) {
    flags.push("Creator / sniper / bundle checks UNVERIFIED (not performed)");
    if (risk === "Safe") risk = "Unverified";
  } else {
    flags.push(...forensics.redFlags);
    flags.push(...forensics.suspected.map((s) => `SUSPECTED: ${s}`));
    if (forensics.snipers.length)
      flags.push(`Snipers: ${forensics.snipers.length} wallet(s) took ${forensics.snipers.reduce((a, s) => a + s.pct, 0).toFixed(1)}% right after launch`);
    if (forensics.status !== "COMPLETE") flags.push(`Wallet forensics ${forensics.status === "UNVERIFIED" ? "UNVERIFIED" : "incomplete"}: ${forensics.limitations[0] ?? "data missing"}`);
    if (forensics.redFlags.length) risk = "High Risk";
    else if (risk !== "High Risk" && (forensics.suspected.length || forensics.snipers.length) && risk !== "Unverified") risk = "Moderate";
    if (risk === "Safe" && forensics.status !== "COMPLETE") risk = "Unverified";
  }
  return { top10Pct: top10, risk, verified: !!holders, excludedAccounts: holders?.excluded ?? 0, flags, ...(forensics ? { forensics } : {}) };
}

export type SecurityInput = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  transferFeeBps: number;
  dexId: string;
};

export type SecurityReport = {
  verdict: "PASS" | "FAIL" | "UNVERIFIED";
  /** null = not checked */
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  liquidity: string;
  flags: string[];
};

function liquidityNote(dexId: string) {
  return dexId === "pumpfun"
    ? "On Pump.fun bonding curve (liquidity held by the program; not independently verified)"
    : dexId === "pumpswap"
      ? "Graduated to PumpSwap (LP burn not independently verified)"
      : `Trading on ${dexId} (LP lock not verified)`;
}

/** s = null means the on-chain mint lookup failed; verdict is then UNVERIFIED, never PASS. */
export function analyzeSecurity(s: SecurityInput | null, dexId: string, failureReason?: string): SecurityReport {
  if (!s) {
    return {
      verdict: "UNVERIFIED",
      mintAuthorityDisabled: null,
      freezeAuthorityDisabled: null,
      liquidity: liquidityNote(dexId),
      flags: [`Security checks not completed: ${failureReason ?? "mint data unavailable"}`],
    };
  }
  const flags: string[] = [];
  if (s.mintAuthority) flags.push("Mint authority is still enabled (dev can print more tokens)");
  if (s.freezeAuthority) flags.push("Freeze authority is enabled (wallets can be frozen — honeypot risk)");
  if (s.transferFeeBps > 0) flags.push(`Hidden transfer tax of ${(s.transferFeeBps / 100).toFixed(2)}%`);
  if (s.extensions.includes("permanentDelegate")) flags.push("Permanent delegate can move anyone's tokens");
  if (s.extensions.includes("transferHook")) flags.push("Custom transfer hook can block sells");
  return {
    verdict: flags.length === 0 ? "PASS" : "FAIL",
    mintAuthorityDisabled: !s.mintAuthority,
    freezeAuthorityDisabled: !s.freezeAuthority,
    liquidity: liquidityNote(s.dexId),
    flags,
  };
}

/** Reject only on verified risk. Unverified tokens are still sent but never marked security-approved. */
export function shouldReject(security: SecurityReport, wallet: WalletReport) {
  return security.verdict === "FAIL" || wallet.risk === "High Risk";
}

export function isSecurityApproved(security: SecurityReport, wallet: WalletReport) {
  return security.verdict === "PASS" && wallet.verified;
}

export const UNVERIFIED_SECURITY_SCORE_CAP = 40;
export const UNVERIFIED_HOLDERS_SCORE_CAP = 60;

/** Missing evidence lowers confidence: cap the AI Opportunity Score. */
export function adjustScoreForEvidence(score: number, security: SecurityReport, wallet: WalletReport) {
  let s = score;
  if (security.verdict !== "PASS") s = Math.min(s, UNVERIFIED_SECURITY_SCORE_CAP);
  if (!wallet.verified) s = Math.min(s, UNVERIFIED_HOLDERS_SCORE_CAP);
  return Math.max(1, s);
}

export function shouldAlert(score: number) {
  return score >= ALERT_MIN_SCORE;
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
