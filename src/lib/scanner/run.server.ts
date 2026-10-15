import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { formatAlert } from "./alert";
import { AiGatewayError, runAiAgents } from "./ai.server";
import { discoverPumpMints, fetchHolderPcts, fetchMintInfo, fetchPairs, type DexPair } from "./data.server";
import {
  analyzeMarket,
  analyzeSecurity,
  analyzeWallets,
  PUMP_GRADUATION_MCAP_USD,
  shouldAlert,
  shouldReject,
  type CoinHunterReport,
} from "./rules";
import { sendTelegram } from "./telegram.server";

const MAX_TOKENS_PER_RUN = 5;
const MIN_CURVE_MCAP = PUMP_GRADUATION_MCAP_USD * 0.5; // "graduating": at least ~50% along the curve

export async function runScan(): Promise<string> {
  const db = supabaseAdmin;
  const { data: state } = await db.from("scanner_state").select("*").eq("id", 1).single();
  if (state?.paused_reason) return `Paused: ${state.paused_reason}`;

  const { data: locked } = await db.rpc("acquire_scanner_lock", { _seconds: 240 });
  if (!locked) return "Another scan is already running";

  let summary = "";
  try {
    const found = await discoverPumpMints();
    const mints = found.map((f) => f.mint);
    const { data: known } = await db.from("scanned_tokens").select("mint").in("mint", mints.length ? mints : ["-"]);
    const knownSet = new Set((known ?? []).map((k) => k.mint));
    const fresh = found.filter((f) => !knownSet.has(f.mint));
    const pairs = await fetchPairs(fresh.map((f) => f.mint));

    const candidates = fresh
      .map((f) => ({ ...f, pair: pairs.get(f.mint) }))
      .filter((c): c is typeof c & { pair: DexPair } => !!c.pair)
      .filter((c) => c.pair.dexId !== "pumpfun" || (c.pair.marketCap ?? 0) >= MIN_CURVE_MCAP)
      .slice(0, MAX_TOKENS_PER_RUN);

    let alerted = 0;
    let rejected = 0;
    for (const c of candidates) {
      const outcome = await analyzeToken(c.mint, c.pair, c.description);
      if (outcome === "paused") {
        summary = "Paused after AI access error";
        return summary;
      }
      if (outcome === "alerted") alerted++;
      if (outcome === "rejected") rejected++;
    }
    summary = `Found ${found.length}, new ${fresh.length}, analyzed ${candidates.length}, rejected ${rejected}, alerted ${alerted}`;
    return summary;
  } finally {
    await db
      .from("scanner_state")
      .update({ lock_until: null, last_run_at: new Date().toISOString(), ...(summary ? { last_run_summary: summary } : {}) })
      .eq("id", 1);
  }
}

async function analyzeToken(mint: string, pair: DexPair, description?: string) {
  const db = supabaseAdmin;
  const hunter: CoinHunterReport = {
    name: pair.baseToken.name || null,
    symbol: pair.baseToken.symbol || null,
    mint,
    mintTimestamp: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    creatorWallet: null,
    missing: [],
  };
  if (!hunter.name) hunter.missing.push("Token Name");
  if (!hunter.symbol) hunter.missing.push("Ticker");
  if (!hunter.mintTimestamp) hunter.missing.push("Mint Timestamp");
  hunter.missing.push("Developer Wallet (not exposed by free sources)");

  await db.from("scanned_tokens").upsert({ mint, name: hunter.name, symbol: hunter.symbol, status: "pending" });

  try {
    const t = pair.txns ?? {};
    const market = analyzeMarket({
      dexId: pair.dexId,
      marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
      volumeM5: pair.volume?.["m5"] ?? 0,
      volumeH1: pair.volume?.["h1"] ?? 0,
      buysM5: t["m5"]?.buys ?? 0,
      sellsM5: t["m5"]?.sells ?? 0,
      buysH1: t["h1"]?.buys ?? 0,
      sellsH1: t["h1"]?.sells ?? 0,
      priceChangeH1: pair.priceChange?.["h1"] ?? null,
    });
    const mintInfo = await fetchMintInfo(mint);
    const security = analyzeSecurity({ ...mintInfo, dexId: pair.dexId });
    const wallet = analyzeWallets(await fetchHolderPcts(mint, mintInfo.supply, pair.pairAddress));
    const socials = {
      description: description ?? null,
      websites: pair.info?.websites?.map((w) => w.url) ?? [],
      socials: pair.info?.socials?.map((s) => `${s.type}: ${s.url}`) ?? [],
    };
    const reports: Record<string, Json> = JSON.parse(JSON.stringify( { hunter, market, wallet, security, socials }));

    if (shouldReject(security, wallet)) {
      const reason = security.verdict === "FAIL" ? security.flags[0] : wallet.flags.find((f) => f.startsWith("RED"));
      await db
        .from("scanned_tokens")
        .update({ status: "rejected", verdict: `REJECTED DUE TO RISK: ${reason}`, reports, updated_at: new Date().toISOString() })
        .eq("mint", mint);
      return "rejected";
    }

    let ai;
    try {
      ai = await runAiAgents({ hunter, market, wallet, security, socials });
    } catch (e) {
      if (e instanceof AiGatewayError && (e.status === 402 || e.status === 403 || e.status === 401)) {
        await db.from("scanner_state").update({ paused_reason: `AI unavailable [${e.status}]: ${e.message}` }).eq("id", 1);
        await db.from("scanned_tokens").delete().eq("mint", mint); // retry after resume
        return "paused";
      }
      throw e;
    }
    reports["social"] = ai.social as unknown as Json;
    reports["opportunity"] = ai.opportunity as unknown as Json;
    reports["chief"] = ai.chief as unknown as Json;

    const score = ai.opportunity.score;
    const alertText = formatAlert({
      name: hunter.name ?? "Unknown",
      symbol: hunter.symbol ?? "?",
      mint,
      score,
      bullets: ai.chief.bullets,
      takeaway: ai.chief.takeaway,
      marketCapUsd: market.marketCapUsd,
    });
    const alert = shouldAlert(score);
    if (alert) await sendTelegram(alertText);
    await db
      .from("scanned_tokens")
      .update({
        status: alert ? "alerted" : "passed",
        score,
        verdict: ai.chief.takeaway,
        reports,
        alert_text: alertText,
        updated_at: new Date().toISOString(),
      })
      .eq("mint", mint);
    return alert ? "alerted" : "passed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("analyze failed", mint, msg);
    await db.from("scanned_tokens").update({ status: "error", error: msg.slice(0, 500) }).eq("mint", mint);
    return "error";
  }
}
