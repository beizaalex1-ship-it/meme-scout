import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { formatAlert } from "./alert";
import { AiGatewayError, runAiAgents } from "./ai.server";
import { discoverPumpMints, fetchHolderPcts, fetchMintInfo, fetchPairs, type DexPair } from "./data.server";
import {
  adjustScoreForEvidence,
  analyzeMarket,
  analyzeSecurity,
  analyzeWallets,
  MAX_LAUNCH_AGE_MIN,
  shouldAlert,
  shouldReject,
  type CoinHunterReport,
} from "./rules";
import { sendTelegram } from "./telegram.server";
import { investigateWallets } from "./forensics.server";

const MAX_TOKENS_PER_RUN = 5;

export async function runScan(): Promise<string> {
  const db = supabaseAdmin;
  const { data: state } = await db.from("scanner_state").select("*").eq("id", 1).single();
  if (state?.paused_reason) return `Paused: ${state.paused_reason}`;

  const { data: locked } = await db.rpc("acquire_scanner_lock", { _seconds: 240 });
  if (!locked) return "Another scan is already running";

  let summary = "";
  try {
    const found = await discoverPumpMints(MAX_LAUNCH_AGE_MIN);
    const mints = found.map((f) => f.mint);
    const { data: known } = await db.from("scanned_tokens").select("mint").in("mint", mints.length ? mints : ["-"]);
    const knownSet = new Set((known ?? []).map((k) => k.mint));
    const fresh = found.filter((f) => !knownSet.has(f.mint));
    const pairs = await fetchPairs(fresh.map((f) => f.mint));

    const candidates = fresh
      .map((f) => ({ ...f, pair: pairs.get(f.mint) }))
      .filter((c): c is typeof c & { pair: DexPair } => !!c.pair)
      // "made well": real early trading activity, plus a bonus for listed website/socials
      .map((c) => {
        const tx = c.pair.txns?.["m5"] ?? { buys: 0, sells: 0 };
        const links = (c.pair.info?.websites?.length ?? 0) + (c.pair.info?.socials?.length ?? 0);
        return { ...c, quality: tx.buys + tx.sells + links * 20 };
      })
      .filter((c) => (c.pair.txns?.["m5"]?.buys ?? 0) >= 3)
      .sort((x, y) => y.quality - x.quality)
      .slice(0, MAX_TOKENS_PER_RUN);

    // Atomically claim candidates: only mints this run inserted are analysed, so an overlapping
    // run (e.g. after lock expiry) can never alert the same coin twice.
    const { data: claimed, error: claimErr } = candidates.length
      ? await db
          .from("scanned_tokens")
          .upsert(
            candidates.map((c) => ({ mint: c.mint, name: c.pair.baseToken.name || null, symbol: c.pair.baseToken.symbol || null, status: "pending" })),
            { onConflict: "mint", ignoreDuplicates: true },
          )
          .select("mint")
      : { data: [], error: null };
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
    const claimedSet = new Set((claimed ?? []).map((r) => r.mint));

    let alerted = 0;
    let rejected = 0;
    for (const c of candidates.filter((x) => claimedSet.has(x.mint))) {
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
    const mintRes = await fetchMintInfo(mint);
    const security = mintRes.ok
      ? analyzeSecurity({ ...mintRes.info, dexId: pair.dexId }, pair.dexId)
      : analyzeSecurity(null, pair.dexId, mintRes.reason);
    const holderRes = mintRes.ok
      ? await fetchHolderPcts(mint, mintRes.info.supply, pair.pairAddress)
      : { ok: false as const, reason: "mint supply unknown" };
    const forensics = await investigateWallets(mint, mintRes.ok ? mintRes.info.supply : 0, [pair.pairAddress]);
    if (forensics.creator.status === "VERIFIED") hunter.creatorWallet = forensics.creator.wallet;
    else hunter.missing.push(`Developer Wallet (UNVERIFIED: ${forensics.creator.evidence})`);
    const wallet = holderRes.ok
      ? analyzeWallets(holderRes.holders, undefined, forensics)
      : analyzeWallets(null, holderRes.reason, forensics);
    console.log(JSON.stringify({ evt: "token_checks", mint, security: security.verdict, holders: wallet.verified ? "verified" : "unverified", forensics: forensics.status }));
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

    const aiScore = ai.opportunity.score;
    const score = adjustScoreForEvidence(aiScore, security, wallet);
    reports["opportunity"] = { ...ai.opportunity, aiScore, score, cappedForMissingEvidence: score < aiScore } as unknown as Json;
    const alertText = formatAlert({
      name: hunter.name ?? "Unknown",
      symbol: hunter.symbol ?? "?",
      mint,
      score,
      bullets: ai.chief.bullets,
      takeaway: ai.chief.takeaway,
      marketCapUsd: market.marketCapUsd,
      security: security.verdict,
      holdersVerified: wallet.verified,
      forensics,
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
