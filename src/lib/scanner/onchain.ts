// On-chain Pump.fun market math (pure, testable). Fetching lives in market.server.ts.
// Prices come from the bonding-curve account itself (constant-product reserves), not from guesses.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PUMP_PROGRAM_ID } from "./forensics";

export const METAPLEX_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const PUMP_TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
export function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

function isOnCurve(b: Uint8Array) {
  try {
    ed25519.Point.fromBytes(b);
    return true;
  } catch {
    return false;
  }
}

/** Solana findProgramAddress. */
export function findPda(seeds: Uint8Array[], programId: string): string {
  const prog = b58decode(programId);
  if (prog.length !== 32 || seeds.length > 15 || seeds.some((s) => s.length > 32)) throw new Error("invalid PDA seeds");
  const tag = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), prog, tag];
    const buf = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const h = sha256(buf);
    if (!isOnCurve(h)) return b58encode(h);
  }
  throw new Error("no PDA");
}

const enc = (s: string) => new TextEncoder().encode(s);
function mintBytes(mint: string) {
  const bytes = b58decode(mint);
  if (bytes.length !== 32) throw new Error("invalid mint address");
  return bytes;
}
export const bondingCurveAddress = (mint: string) => findPda([enc("bonding-curve"), mintBytes(mint)], PUMP_PROGRAM_ID);
export const metadataAddress = (mint: string) => findPda([enc("metadata"), b58decode(METAPLEX_METADATA_PROGRAM), mintBytes(mint)], METAPLEX_METADATA_PROGRAM);

export type CurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
};

function b64(s: string) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Pump.fun BondingCurve account: 8-byte discriminator, 5×u64 reserves, bool complete. Null if not a curve. */
export function decodeBondingCurve(base64: string): CurveState | null {
  let d: Uint8Array;
  try { d = b64(base64); } catch { return null; }
  if (d.length < 49) return null;
  const discriminator = sha256(new TextEncoder().encode("account:BondingCurve")).slice(0, 8);
  if (!discriminator.every((x, i) => d[i] === x) || (d[48] !== 0 && d[48] !== 1)) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u = (o: number) => v.getBigUint64(o, true);
  const s: CurveState = {
    virtualTokenReserves: u(8),
    virtualSolReserves: u(16),
    realTokenReserves: u(24),
    realSolReserves: u(32),
    tokenTotalSupply: u(40),
    complete: d[48] === 1,
  };
  if (s.virtualTokenReserves === 0n || s.virtualSolReserves === 0n) return null;
  return s;
}

/** SOL per whole token from curve reserves. */
export function curvePriceSol(c: CurveState) {
  return Number(c.virtualSolReserves) / LAMPORTS_PER_SOL / (Number(c.virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS);
}

/** Metaplex metadata: key(1) update_authority(32) mint(32) then borsh strings name, symbol, uri. */
export function decodeMetaplexNameSymbol(base64: string): { name: string; symbol: string } | null {
  const d = b64(base64);
  if (d.length < 65 + 8) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 65;
  const str = () => {
    const len = v.getUint32(o, true);
    o += 4;
    if (len > 200 || o + len > d.length) throw new Error("bad string");
    const s = new TextDecoder().decode(d.subarray(o, o + len)).replace(/\0+$/, "").trim();
    o += len;
    return s;
  };
  try {
    return { name: str(), symbol: str() };
  } catch {
    return null;
  }
}

/** Value with its provenance. value=null means unavailable (never a verified zero). */
export type Sourced<T> = { value: T | null; source: string; at: string | null; note?: string };

export type ParsedTrade = { signature: string; time: number; wallet: string; side: "buy" | "sell"; sol: number; tokens: number };

type TradeTx = {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: { mint?: string; owner?: string; uiTokenAmount?: { uiAmount?: number | null } }[] | null;
    postTokenBalances?: { mint?: string; owner?: string; uiTokenAmount?: { uiAmount?: number | null } }[] | null;
  } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: ({ pubkey?: string } | string)[] } };
} | null;

/**
 * A trade = SOL and token balances of the bonding curve moving in opposite directions.
 * Buy: curve gains SOL and loses tokens. The trader is the wallet whose token balance moved the other way.
 * Returns null for non-trade transactions (create, failed, unrelated).
 */
export function parseCurveTrade(tx: TradeTx, signature: string, mint: string, curve: string): ParsedTrade | null {
  const m = tx?.meta;
  if (!tx || !m || m.err || typeof tx.blockTime !== "number") return null;
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : (k.pubkey ?? "")));
  const ci = keys.indexOf(curve);
  if (ci < 0 || !m.preBalances || !m.postBalances) return null;
  const solDelta = ((m.postBalances[ci] ?? 0) - (m.preBalances[ci] ?? 0)) / LAMPORTS_PER_SOL;
  const amt = (list: typeof m.postTokenBalances, owner: string) =>
    (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((a, b) => a + (b.uiTokenAmount?.uiAmount ?? 0), 0);
  const owners = new Set([...(m.preTokenBalances ?? []), ...(m.postTokenBalances ?? [])].filter((b) => b.mint === mint && b.owner).map((b) => b.owner as string));
  const curveTok = amt(m.postTokenBalances, curve) - amt(m.preTokenBalances, curve);
  if (solDelta === 0 || curveTok === 0 || Math.sign(solDelta) === Math.sign(curveTok)) return null;
  owners.delete(curve);
  let trader = "";
  let best = 0;
  for (const o of owners) {
    const d = amt(m.postTokenBalances, o) - amt(m.preTokenBalances, o);
    if (Math.sign(d) === -Math.sign(curveTok) && Math.abs(d) > best) {
      best = Math.abs(d);
      trader = o;
    }
  }
  if (!trader) return null;
  return { signature, time: tx.blockTime, wallet: trader, side: solDelta > 0 ? "buy" : "sell", sol: Math.abs(solDelta), tokens: Math.abs(curveTok) };
}

export type ActivitySummary = {
  windowSec: number;
  /** all successful transactions touching the curve in the window (from the signature list) */
  txCount: number;
  failedTxCount: number;
  /** parsed sample */
  sampled: number;
  sampleComplete: boolean;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buySol: number;
  sellSol: number;
  lastTradeAt: number | null;
  firstSampleAt: number | null;
};

/** Counts over [now-windowSec, now]. `sampleComplete` = every successful tx in the window was parsed. */
export function summarizeActivity(
  sigs: { signature: string; blockTime?: number | null; err?: unknown }[],
  trades: ParsedTrade[],
  nowSec: number,
  windowSec: number,
): ActivitySummary {
  const inWin = sigs.filter((s) => typeof s.blockTime === "number" && nowSec >= s.blockTime && nowSec - s.blockTime <= windowSec);
  const ok = inWin.filter((s) => !s.err);
  const t = trades.filter((x) => nowSec >= x.time && nowSec - x.time <= windowSec);
  const buys = t.filter((x) => x.side === "buy");
  const sells = t.filter((x) => x.side === "sell");
  const parsedSigs = new Set(trades.map((x) => x.signature));
  return {
    windowSec,
    txCount: ok.length,
    failedTxCount: inWin.length - ok.length,
    sampled: t.length,
    sampleComplete: ok.every((s) => parsedSigs.has(s.signature)),
    buys: buys.length,
    sells: sells.length,
    uniqueBuyers: new Set(buys.map((x) => x.wallet)).size,
    uniqueSellers: new Set(sells.map((x) => x.wallet)).size,
    buySol: round(buys.reduce((a, x) => a + x.sol, 0)),
    sellSol: round(sells.reduce((a, x) => a + x.sol, 0)),
    lastTradeAt: t.length ? Math.max(...t.map((x) => x.time)) : null,
    firstSampleAt: t.length ? Math.min(...t.map((x) => x.time)) : null,
  };
}
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Market data older than this at analysis time is stale and cannot be used for approval. */
export const MAX_MARKET_AGE_SEC = 120;

export type MarketReadiness = { analyzable: true } | { analyzable: false; reason: string };

/** Mandatory: a fresh, positive price (SOL and USD), and a trade-activity read that succeeded. */
export function marketReadiness(
  m: { priceSol: Sourced<number>; priceUsd: Sourced<number>; activity: ActivitySummary | null; activityError?: string | null },
  nowMs: number,
): MarketReadiness {
  for (const [label, f] of [["price (SOL)", m.priceSol], ["price (USD)", m.priceUsd]] as const) {
    if (f.value === null || !Number.isFinite(f.value) || !(f.value > 0)) return { analyzable: false, reason: `${label} unavailable${f.note ? `: ${f.note}` : ""}` };
    const at = f.at ? Date.parse(f.at) : NaN;
    if (!Number.isFinite(at) || at > nowMs || nowMs - at > MAX_MARKET_AGE_SEC * 1000) return { analyzable: false, reason: `${label} stale (from ${f.at ?? "unknown time"})` };
  }
  if (!m.activity) return { analyzable: false, reason: `trade activity unavailable${m.activityError ? `: ${m.activityError}` : ""}` };
  return { analyzable: true };
}

export const UNANALYZED_LABEL = "UNANALYZED — MISSING MARKET DATA";
