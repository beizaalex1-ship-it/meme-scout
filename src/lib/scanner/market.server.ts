// Live market data: Helius (on-chain bonding curve + trades) first, DexScreener as backup.
// Every value carries its source and timestamp; unavailable values stay null, never zero.
import { rpc, type MintResult, type DexPair } from "./data.server";
import { getJsonPolite } from "./http";
import { PUMP_PROGRAM_ID } from "./forensics";
import {
  bondingCurveAddress,
  curvePriceSol,
  decodeBondingCurve,
  decodeMetaplexNameSymbol,
  LAMPORTS_PER_SOL,
  metadataAddress,
  parseCurveTrade,
  summarizeActivity,
  type ActivitySummary,
  type CurveState,
  type ParsedTrade,
  type Sourced,
} from "./onchain";

/** Newest successful curve transactions parsed per analyzed coin (1 credit each). */
export const TRADE_SAMPLE = 12;
export const ACTIVITY_WINDOW_SEC = 300;
export const SIG_LIST_LIMIT = 100;

type AcctB64 = { owner: string; data: [string, string] | { parsed?: { info?: Record<string, unknown> } } } | null;

export type OnchainCoin = {
  mint: string;
  curveAddress: string;
  mintRes: MintResult;
  curve: CurveState | null;
  curveNote: string | null;
  name: string | null;
  symbol: string | null;
  readAt: string | null;
  slot: number | null;
};

type ParsedMintInfo = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
};

function parseMintAcct(a: AcctB64): { res: MintResult; name: string | null; symbol: string | null } {
  const info = a && !Array.isArray(a.data) ? (a.data.parsed?.info as ParsedMintInfo | undefined) : undefined;
  if (!info || typeof info.decimals !== "number" || info.supply === undefined)
    return { res: { ok: false, reason: "mint account not found or not a parsed SPL mint" }, name: null, symbol: null };
  const ext = info.extensions ?? [];
  const fee = ext.find((e) => e.extension === "transferFeeConfig")?.state as { newerTransferFee?: { transferFeeBasisPoints?: number } } | undefined;
  const md = ext.find((e) => e.extension === "tokenMetadata")?.state as { name?: string; symbol?: string } | undefined;
  return {
    res: {
      ok: true,
      info: {
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        supply: Number(info.supply) / 10 ** info.decimals,
        extensions: ext.map((e) => e.extension),
        transferFeeBps: fee?.newerTransferFee?.transferFeeBasisPoints ?? 0,
      },
    },
    name: md?.name?.trim() || null,
    symbol: md?.symbol?.trim() || null,
  };
}

/** One getMultipleAccounts per 33 coins (mint + bonding curve + metadata): mint safety, price and name together. */
export async function fetchOnchainBatch(mints: string[]): Promise<Map<string, OnchainCoin>> {
  const out = new Map<string, OnchainCoin>();
  for (let i = 0; i < mints.length; i += 33) {
    const chunk = mints.slice(i, i + 33);
    const addrs: { m: string; curve: string; meta: string }[] = [];
    for (const m of chunk) {
      try { addrs.push({ m, curve: bondingCurveAddress(m), meta: metadataAddress(m) }); }
      catch { out.set(m, { mint: m, curveAddress: "", mintRes: { ok: false, reason: "invalid mint address" }, curve: null, curveNote: "invalid mint address", name: null, symbol: null, readAt: null, slot: null }); }
    }
    if (!addrs.length) continue;
    try {
      const r = await rpc<{ context: { slot: number }; value: AcctB64[] }>("getMultipleAccounts", [
        addrs.flatMap((a) => [a.m, a.curve, a.meta]),
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      const at = new Date().toISOString();
      addrs.forEach((a, j) => {
        const [mAcct, cAcct, mdAcct] = [r.value[j * 3] ?? null, r.value[j * 3 + 1] ?? null, r.value[j * 3 + 2] ?? null];
        const pm = parseMintAcct(mAcct);
        const curve = cAcct?.owner === PUMP_PROGRAM_ID && Array.isArray(cAcct.data) ? decodeBondingCurve(cAcct.data[0]) : null;
        const md = !pm.name && mdAcct && Array.isArray(mdAcct.data) ? decodeMetaplexNameSymbol(mdAcct.data[0]) : null;
        out.set(a.m, {
          mint: a.m,
          curveAddress: a.curve,
          mintRes: pm.res,
          curve,
          curveNote: !cAcct ? "bonding curve account not found" : !curve ? "bonding curve not decodable" : curve.complete ? "bonding curve complete (graduated)" : null,
          name: pm.name ?? md?.name ?? null,
          symbol: pm.symbol ?? md?.symbol ?? null,
          readAt: at,
          slot: r.context?.slot ?? null,
        });
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      for (const a of addrs)
        out.set(a.m, { mint: a.m, curveAddress: a.curve, mintRes: { ok: false, reason }, curve: null, curveNote: reason, name: null, symbol: null, readAt: null, slot: null });
    }
  }
  return out;
}

/** SOL/USD from free reference prices, first that answers. Clearly labelled; null if all fail. */
export async function fetchSolUsd(): Promise<Sourced<number>> {
  const sources: [string, string, (j: any) => unknown][] = [
    ["jupiter", "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", (j) => j?.["So11111111111111111111111111111111111111112"]?.usdPrice],
    ["kraken", "https://api.kraken.com/0/public/Ticker?pair=SOLUSD", (j) => Number(j?.result?.SOLUSD?.c?.[0])],
    ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => j?.solana?.usd],
  ];
  const errs: string[] = [];
  const requestedAt = new Date().toISOString();
  for (const [name, url, pick] of sources) {
    try {
      const v = Number(pick(await getJsonPolite<unknown>(url, { retries: 1, cacheTtlMs: 0 })));
      if (Number.isFinite(v) && v > 0) return { value: v, source: `${name} SOL/USD`, at: requestedAt };
      errs.push(`${name}: no price`);
    } catch (e) {
      errs.push(`${name}: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
    }
  }
  return { value: null, source: "none", at: null, note: errs.join("; ") };
}

export type Activity = { summary: ActivitySummary; trades: ParsedTrade[]; oldestSigTime: number | null; listComplete: boolean };

/** 1 credit signature list + up to TRADE_SAMPLE transaction reads. Throws on failure (caller marks UNANALYZED). */
export async function fetchActivity(mint: string, curve: string, nowSec = Math.floor(Date.now() / 1000)): Promise<Activity> {
  const sigs = await rpc<{ signature: string; blockTime?: number | null; err?: unknown }[]>("getSignaturesForAddress", [curve, { limit: SIG_LIST_LIMIT, commitment: "confirmed" }]);
  const recent = sigs.filter((s) => !s.err && typeof s.blockTime === "number" && nowSec >= s.blockTime && nowSec - s.blockTime <= ACTIVITY_WINDOW_SEC).slice(0, TRADE_SAMPLE);
  const trades: ParsedTrade[] = [];
  const parsed = new Set<string>();
  for (const s of recent) {
    const tx = await rpc<Parameters<typeof parseCurveTrade>[0]>("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    if (!tx || !tx.meta || tx.meta.err || typeof tx.blockTime !== "number") throw new Error("Trade transaction unavailable or invalid");
    parsed.add(s.signature);
    const t = parseCurveTrade(tx, s.signature, mint, curve);
    if (t) trades.push(t);
  }
  // Non-trade txs that were read still count as "covered" for sample completeness.
  const covered = sigs.filter((s) => parsed.has(s.signature));
  const summary = summarizeActivity(sigs, trades, nowSec, ACTIVITY_WINDOW_SEC);
  const successful = sigs.filter((s) => !s.err && typeof s.blockTime === "number" && nowSec >= s.blockTime && nowSec - s.blockTime <= ACTIVITY_WINDOW_SEC);
  const timesInList = sigs.flatMap((s) => typeof s.blockTime === "number" ? [s.blockTime] : []);
  const coversWindow = sigs.length < SIG_LIST_LIMIT || timesInList.some((t) => t < nowSec - ACTIVITY_WINDOW_SEC);
  summary.sampleComplete = coversWindow && successful.every((s) => covered.some((c) => c.signature === s.signature));
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
  return { summary, trades, oldestSigTime: times.length ? Math.min(...times) : null, listComplete: sigs.length < SIG_LIST_LIMIT };
}

export type MarketData = {
  source: "helius" | "dexscreener";
  priceSol: Sourced<number>;
  priceUsd: Sourced<number>;
  solUsd: Sourced<number>;
  marketCapUsd: Sourced<number>;
  curveSol: Sourced<number>;
  liquidityUsd: Sourced<number>;
  bondingCurvePct: Sourced<number>;
  activity: (ActivitySummary & { source: string; at: string }) | null;
  activityError: string | null;
  launchedAt: Sourced<string>;
  missing: string[];
};

const PUMP_INITIAL_REAL_TOKENS = 793_100_000; // tokens sellable on a fresh Pump.fun curve (6 decimals)

/** Combine on-chain data (primary) with DexScreener (backup). Nothing is invented; gaps go in `missing`. */
export function buildMarketData(oc: OnchainCoin | undefined, dex: DexPair | undefined, dexAt: string | null, solUsd: Sourced<number>, supply: number | null): MarketData {
  const missing: string[] = [];
  const na = (source: string, note: string): Sourced<number> => ({ value: null, source, at: null, note });
  const c = oc?.curve && !oc.curve.complete ? oc.curve : null;
  if (c && oc?.readAt) {
    const ps = curvePriceSol(c);
    const at = oc.readAt;
    const priceSol: Sourced<number> = { value: ps, source: "helius bonding curve", at };
    const priceUsd: Sourced<number> = solUsd.value ? { value: ps * solUsd.value, source: `bonding curve × ${solUsd.source} (estimate)`, at: solUsd.at && solUsd.at < at ? solUsd.at : at } : na("bonding curve", `SOL/USD unavailable: ${solUsd.note ?? ""}`);
    const curveSol = Number(c.realSolReserves) / LAMPORTS_PER_SOL;
    const soldPct = Math.max(0, Math.min(100, Math.round((1 - Number(c.realTokenReserves) / 1e6 / PUMP_INITIAL_REAL_TOKENS) * 1000) / 10));
    if (!solUsd.value) missing.push("SOL/USD reference price");
    return {
      source: "helius",
      priceSol,
      priceUsd,
      solUsd,
      marketCapUsd: priceUsd.value !== null && supply ? { value: priceUsd.value * supply, source: "price × on-chain supply (estimate)", at: priceUsd.at } : na("derived", "price or supply unavailable"),
      curveSol: { value: curveSol, source: "helius bonding curve (real SOL reserves)", at },
      liquidityUsd: solUsd.value ? { value: curveSol * solUsd.value, source: `curve SOL × ${solUsd.source} (estimate)`, at } : na("derived", "SOL/USD unavailable"),
      bondingCurvePct: { value: soldPct, source: "helius bonding curve (tokens sold)", at },
      activity: null,
      activityError: null,
      launchedAt: { value: null, source: "pending", at: null },
      missing,
    };
  }
  if (oc?.curveNote) missing.push(`On-chain price: ${oc.curveNote}`);
  const dp = dex?.priceUsd !== undefined ? Number(dex.priceUsd) : NaN;
  if (dex && Number.isFinite(dp) && dp > 0 && dexAt) {
    return {
      source: "dexscreener",
      priceSol: solUsd.value ? { value: dp / solUsd.value, source: `dexscreener ÷ ${solUsd.source} (estimate)`, at: solUsd.at && solUsd.at < dexAt ? solUsd.at : dexAt } : na("dexscreener", "SOL/USD unavailable"),
      priceUsd: { value: dp, source: "dexscreener (backup)", at: dexAt },
      solUsd,
      marketCapUsd: dex.marketCap ?? dex.fdv ? { value: (dex.marketCap ?? dex.fdv) as number, source: "dexscreener (backup)", at: dexAt } : na("dexscreener", "not reported"),
      curveSol: na("dexscreener", "not reported"),
      liquidityUsd: typeof dex.liquidity?.usd === "number" ? { value: dex.liquidity.usd, source: "dexscreener (backup)", at: dexAt } : na("dexscreener", "not reported"),
      bondingCurvePct: na("dexscreener", "not reported"),
      activity: null,
      activityError: null,
      launchedAt: dex.pairCreatedAt ? { value: new Date(dex.pairCreatedAt).toISOString(), source: "dexscreener", at: dexAt } : { value: null, source: "dexscreener", at: null },
      missing,
    };
  }
  missing.push("DexScreener backup unavailable");
  return {
    source: "helius",
    priceSol: na("helius bonding curve", oc?.curveNote ?? "not read"),
    priceUsd: na("none", "no price source available"),
    solUsd,
    marketCapUsd: na("none", "no price"),
    curveSol: na("none", "no price"),
    liquidityUsd: na("none", "no price"),
    bondingCurvePct: na("none", "no price"),
    activity: null,
    activityError: null,
    launchedAt: { value: null, source: "none", at: null },
    missing,
  };
}

/** Adapter so existing market/wallet/AI/outcome code keeps working. Only real values are filled; trade counts are the parsed sample. */
export function toPairLike(mint: string, oc: OnchainCoin | undefined, dex: DexPair | undefined, md: MarketData): DexPair {
  const a = md.activity;
  const solUsd = md.solUsd.value;
  const volUsd = a && solUsd ? (a.buySol + a.sellSol) * solUsd : undefined;
  const tx = a ? { buys: a.buys, sells: a.sells } : undefined;
  return {
    dexId: oc?.curve ? (oc.curve.complete ? "pumpswap" : "pumpfun") : (dex?.dexId ?? "pumpfun"),
    pairAddress: oc?.curve && !oc.curve.complete ? oc.curveAddress : (dex?.pairAddress ?? oc?.curveAddress ?? ""),
    ...(md.priceUsd.value !== null ? { priceUsd: String(md.priceUsd.value) } : {}),
    baseToken: { address: mint, name: oc?.name ?? dex?.baseToken.name ?? "", symbol: oc?.symbol ?? dex?.baseToken.symbol ?? "" },
    ...(tx ? { txns: { m5: tx } } : {}),
    ...(volUsd !== undefined ? { volume: { m5: volUsd } } : {}),
    ...(md.marketCapUsd.value !== null ? { marketCap: md.marketCapUsd.value } : {}),
    ...(md.liquidityUsd.value !== null ? { liquidity: { usd: md.liquidityUsd.value } } : {}),
    ...(md.launchedAt.value ? { pairCreatedAt: Date.parse(md.launchedAt.value) } : {}),
    ...(dex?.info ? { info: dex.info } : {}),
  };
}

/** Read activity independently of price; explicit indexed backup on RPC failure. */
export async function attachActivity(mint: string, oc: OnchainCoin | undefined, dex: DexPair | undefined, dexAt: string | null, md: MarketData): Promise<MarketData> {
  try {
    if (!oc?.curve || oc.curve.complete) throw new Error("Active bonding curve unavailable");
    const a = await fetchActivity(mint, oc.curveAddress);
    md.activity = { ...a.summary, source: "helius curve transactions (SOL movement; sampled)", at: new Date().toISOString() };
  } catch (e) {
    md.activityError = e instanceof Error ? e.message : "Activity lookup failed";
    const tx = dex?.txns?.["m5"];
    if (tx && dexAt && Number.isFinite(tx.buys) && Number.isFinite(tx.sells)) {
      md.activity = { windowSec: 300, txCount: tx.buys + tx.sells, failedTxCount: 0, sampled: 0, sampleComplete: false,
        buys: tx.buys, sells: tx.sells, uniqueBuyers: 0, uniqueSellers: 0, buySol: 0, sellSol: 0,
        lastTradeAt: null, firstSampleAt: null, source: "dexscreener aggregate backup (unique wallets/SOL unavailable)", at: dexAt };
      md.missing.push("Unique buyers, sellers and SOL flow unavailable in indexed backup");
    }
  }
  if (!md.activity) md.missing.push(`Trade activity: ${md.activityError ?? "unavailable"}`);
  return md;
}
