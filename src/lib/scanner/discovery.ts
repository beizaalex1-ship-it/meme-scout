// Helius discovery fallback: pure logic (testable). Fetching lives in discovery.server.ts.
// A launch transaction only proves a token was created — never that it is safe or promising.
import { PUMP_PROGRAM_ID } from "./forensics";

/** Pump.fun mint authority: signs every Pump.fun token creation (verified live against CreateV2 txs). */
export const PUMP_LAUNCH_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
export const SIGNATURE_LIMIT = 1000;
export const MIN_LAUNCH_AGE_MIN = 1; // DexScreener needs a moment to list trading data
/** 32 wallet + 2 holder + 13 activity calls, each with up to five attempts. */
export const RESERVE_PER_COIN = 235;

export type RawSig = { signature: string; blockTime?: number | null; err?: unknown };
export type RawLaunchTx = {
  meta?: { err?: unknown; logMessages?: string[] | null; postTokenBalances?: { mint?: string }[] | null } | null;
  transaction?: { message?: { accountKeys?: ({ pubkey?: string; signer?: boolean } | string)[] } };
} | null;

export type LaunchParse = { ok: true; mint: string } | { ok: false; reason: string };

/** Mint = non-fee-payer signer that also appears as a token mint, in a successful Pump.fun Create tx. */
export function extractLaunchMint(raw: RawLaunchTx): LaunchParse {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "transaction not returned" };
  const meta = raw.meta;
  const keys = raw.transaction?.message?.accountKeys;
  if (!meta || !Array.isArray(keys) || !keys.length) return { ok: false, reason: "malformed transaction" };
  if (meta.err) return { ok: false, reason: "failed on-chain" };
  const logs = Array.isArray(meta.logMessages) ? meta.logMessages : [];
  if (!logs.some((l) => typeof l === "string" && l.startsWith(`Program ${PUMP_PROGRAM_ID} invoke`)))
    return { ok: false, reason: "Pump.fun program not invoked" };
  if (!logs.some((l) => /^Program log: Instruction: Create(V2)?$/.test(l))) return { ok: false, reason: "not a create instruction" };
  const signers = keys
    .filter((k): k is { pubkey: string; signer: boolean } => typeof k === "object" && !!k && typeof k.pubkey === "string" && k.signer === true)
    .map((k) => k.pubkey);
  const mints = new Set((meta.postTokenBalances ?? []).map((b) => b?.mint).filter((m): m is string => typeof m === "string"));
  const candidates = signers.slice(1).filter((s) => mints.has(s));
  if (candidates.length !== 1) return { ok: false, reason: `expected one mint signer, found ${candidates.length}` };
  const mint = candidates[0];
  return mint ? { ok: true, mint } : { ok: false, reason: "mint signer missing" };
}

/** Successful signatures inside the launch-age window not processed before, newest first, up to cap. */
export function selectSignatures(sigs: RawSig[], seen: Set<string>, nowSec: number, maxAgeMin: number, cap: number) {
  const eligible = sigs.filter(
    (s) => !s.err && typeof s.blockTime === "number" && nowSec - s.blockTime >= MIN_LAUNCH_AGE_MIN * 60 && nowSec - s.blockTime <= maxAgeMin * 60 && !seen.has(s.signature),
  );
  eligible.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
  return { eligible: eligible.length, picked: eligible.slice(0, Math.max(0, cap)) };
}

/** How many transaction lookups this scan may spend without touching the reserve or the monthly budget. */
export function planHeliusBudget(p: { monthlyBudget: number; usedThisMonth: number; maxCoins: number; maxTx: number }) {
  const reserve = p.maxCoins * RESERVE_PER_COIN;
  const left = p.monthlyBudget - p.usedThisMonth - reserve - 10; // listing + account batch, five attempts each
  if (p.maxTx <= 0) return { allowedTx: 0, reason: "Helius discovery disabled (limit 0)" };
  if (left <= 0) return { allowedTx: 0, reason: `Monthly budget reached (${p.usedThisMonth.toLocaleString("en-US")} of ${p.monthlyBudget.toLocaleString("en-US")} used, ${reserve} reserved for checks)` };
  return { allowedTx: Math.min(p.maxTx, left), reason: null as string | null };
}

/** Coins this scan can still afford full checks for (1 credit kept for the batched mint check). */
export function affordableCoins(allowance: number, spent: number, maxCoins: number) {
  return Math.max(0, Math.min(maxCoins, Math.floor((allowance - spent) / RESERVE_PER_COIN)));
}
