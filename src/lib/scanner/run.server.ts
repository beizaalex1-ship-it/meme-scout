import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { formatAlert } from "./alert";
import { AiGatewayError, runAiAgents } from "./ai.server";
import { discoverPumpMints, resetRpcUsage, rpcUsage, fetchHolderPcts, fetchMintInfoBatch, type MintResult, fetchPairs, type DexPair, fetchDexPaid } from "./data.server";
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
import { planCandidates } from "./optimizer";
import { predictionMarket, recordPrediction } from "./outcomes.server";

export const DEFAULT_MAX_COINS_PER_RUN = 3;

export async function runScan(): Promise<string> {
  const db = supabaseAdmin;
  const { data: state } = await db.from("scanner_state").select("*").eq("id", 1).single();
  if (state?.paused_reason) return `Paused: ${state.paused_reason}`;

  const { data: locked } = await db.rpc("acquire_scanner_lock", { _seconds: 240 });
  if (!locked) return "Another scan is already running";

  let summary = "";
  let analyzedCount = 0;
  const opt = { earlyRejected: 0, skippedUnverified: 0, holderRejected: 0 };
  const maxCoins = Math.min(10, Math.max(1, state?.max_coins_per_run ?? DEFAULT_MAX_COINS_PER_RUN));
  resetRpcUsage();
  try {
    const found = await discoverPumpMints(MAX_LAUNCH_AGE_MIN);
    const mints = found.map((f) => f.mint);
    const { data: known } = await db.from("scanned_tokens").select("mint").in("mint", mints.length ? mints : ["-"]);
    const knownSet = new Set((known ?? []).map((k) => k.mint));
    const fresh = found.filter((f) => !knownSet.has(f.mint));
    // A market-data failure ends this scan's candidate list, not the scan itself.
    let pairs = new Map<string, DexPair>();
    let marketFailed = "";
    try {
      pairs = await fetchPairs(fresh.map((f) => f.mint));
    } catch (e) {
      marketFailed = e instanceof Error ? e.message.slice(0, 120) : String(e);
      console.error(JSON.stringify({ evt: "market_data_failed", stage: "discovery", coins: fresh.length, error: marketFailed }));
    }

    const prelim = fresh
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
      .slice(0, 30);

    // Credits optimizer: one batched Helius request checks every candidate's mint, then only
    // coins with verified PASS safety data get the expensive holder/forensics/AI checks.
    const mintInfo = await fetchMintInfoBatch(prelim.map((c) => c.mint));
    const withSec = prelim.map((c) => {
      const m: MintResult = mintInfo.get(c.mint) ?? { ok: false, reason: "not returned" };
      const security = m.ok ? analyzeSecurity({ ...m.info, dexId: c.pair.dexId }, c.pair.dexId) : analyzeSecurity(null, c.pair.dexId, m.reason);
      return { ...c, mintRes: m, security };
    });
    const plan = planCandidates(withSec.map((c) => ({ item: c, quality: c.quality, security: c.security })), maxCoins);
    opt.skippedUnverified = plan.skippedUnverified.length;
    if (plan.earlyReject.length) {
      const { data: ins } = await db
        .from("scanned_tokens")
        .upsert(
          plan.earlyReject.map((c) => ({
            mint: c.mint,
            name: c.pair.baseToken.name || null,
            symbol: c.pair.baseToken.symbol || null,
            status: "rejected",
            verdict: `REJECTED DUE TO RISK: ${c.security.flags[0]}`,
            reports: JSON.parse(JSON.stringify({ security: c.security, optimizer: "Rejected on the first Helius check; no further credits spent" })),
          })),
          { onConflict: "mint", ignoreDuplicates: true },
        )
        .select("mint");
      opt.earlyRejected = ins?.length ?? 0;
      const insSet = new Set((ins ?? []).map((r) => r.mint));
      for (const c of plan.earlyReject.filter((x) => insSet.has(x.mint)))
        await recordPrediction({
          mint: c.mint, name: c.pair.baseToken.name || null, symbol: c.pair.baseToken.symbol || null, detectedAt: new Date(),
          pairCreatedAt: c.pair.pairCreatedAt ?? null, status: "rejected", verdict: `REJECTED DUE TO RISK: ${c.security.flags[0]}`,
          score: null, securityVerdict: c.security.verdict, walletRisk: null, market: predictionMarket(c.pair),
          reports: { security: c.security }, missing: ["Wallet, social and opportunity checks skipped (early security rejection)"],
        });
    }
    const candidates = plan.analyze;

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
      analyzedCount++;
      const outcome = await analyzeToken(c.mint, c.pair, c.mintRes, c.description);
      if (outcome === "holder_rejected") opt.holderRejected++;
      if (outcome === "paused") {
        summary = "Paused after AI access error";
        return summary;
      }
      if (outcome === "alerted") alerted++;
      if (outcome === "rejected" || outcome === "holder_rejected") rejected++;
    }
    summary = `Found ${found.length}, new ${fresh.length}, analyzed ${candidates.length}, rejected ${rejected + opt.earlyRejected}, alerted ${alerted}, skipped unverified ${opt.skippedUnverified}${marketFailed ? ` — market data unavailable, ${fresh.length} coins left for next scan` : ""}`;
    return summary;
  } finally {
    await db.from("scan_runs").insert({
      coins_checked: analyzedCount,
      rpc_calls: rpcUsage.total,
      calls_by_method: { ...rpcUsage.byMethod },
      early_rejected: opt.earlyRejected,
      skipped_unverified: opt.skippedUnverified,
      holder_rejected: opt.holderRejected,
      summary: summary || null,
    });
    await db
      .from("scanner_state")
      .update({ lock_until: null, last_run_at: new Date().toISOString(), ...(summary ? { last_run_summary: summary } : {}) })
      .eq("id", 1);
  }
}

async function analyzeToken(mint: string, pair: DexPair, mintRes: MintResult, description?: string) {
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
  // Market data frozen at detection time; outcome tracking compares against this.
  const detectedAt = new Date();
  const detectedMarket = predictionMarket(pair);
  const freeze = (p: { status: "rejected" | "passed" | "alerted"; verdict: string | null; score: number | null; securityVerdict: string; walletRisk: string | null; reports: Record<string, unknown>; extraMissing?: string[] }) =>
    recordPrediction({ mint, name: hunter.name, symbol: hunter.symbol, detectedAt, pairCreatedAt: pair.pairCreatedAt ?? null, market: detectedMarket, missing: [...hunter.missing, ...(p.extraMissing ?? [])], ...p });


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
    const security = mintRes.ok
      ? analyzeSecurity({ ...mintRes.info, dexId: pair.dexId }, pair.dexId)
      : analyzeSecurity(null, pair.dexId, mintRes.reason);
    const holderRes = mintRes.ok
      ? await fetchHolderPcts(mint, mintRes.info.supply, pair.pairAddress)
      : { ok: false as const, reason: "mint supply unknown" };
    // Cheap holder check first: verified high concentration rejects before ~30-credit forensics.
    if (holderRes.ok) {
      const quick = analyzeWallets(holderRes.holders);
      if (quick.risk === "High Risk") {
        await db
          .from("scanned_tokens")
          .update({
            status: "rejected",
            verdict: `REJECTED DUE TO RISK: ${quick.flags.find((f) => f.startsWith("RED"))}`,
            reports: JSON.parse(JSON.stringify({ hunter, market, wallet: quick, security, optimizer: "Rejected on holder check; wallet forensics skipped to save credits" })),
            updated_at: new Date().toISOString(),
          })
          .eq("mint", mint);
        await freeze({ status: "rejected", verdict: `REJECTED DUE TO RISK: ${quick.flags.find((f) => f.startsWith("RED"))}`, score: null, securityVerdict: security.verdict, walletRisk: quick.risk, reports: { hunter, market, wallet: quick, security }, extraMissing: ["Wallet forensics, social and opportunity skipped (holder rejection)"] });
        return "holder_rejected";
      }
    }
    const forensics = await investigateWallets(mint, mintRes.ok ? mintRes.info.supply : 0, [pair.pairAddress]);
    if (forensics.creator.status === "VERIFIED") hunter.creatorWallet = forensics.creator.wallet;
    else hunter.missing.push(`Developer Wallet (UNVERIFIED: ${forensics.creator.evidence})`);
    const wallet = holderRes.ok
      ? analyzeWallets(holderRes.holders, undefined, forensics)
      : analyzeWallets(null, holderRes.reason, forensics);
    console.log(JSON.stringify({ evt: "token_checks", mint, security: security.verdict, holders: wallet.verified ? "verified" : "unverified", forensics: forensics.status }));
    const dexPaid = await fetchDexPaid(mint);
    const socials = {
      dexPaid,
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
      await freeze({ status: "rejected", verdict: `REJECTED DUE TO RISK: ${reason}`, score: null, securityVerdict: security.verdict, walletRisk: wallet.risk, reports, extraMissing: ["Social and opportunity skipped (risk rejection)"] });
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
      dexPaid,
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
    await freeze({ status: alert ? "alerted" : "passed", verdict: ai.chief.takeaway, score, securityVerdict: security.verdict, walletRisk: wallet.risk, reports, extraMissing: security.verdict !== "PASS" ? ["Security UNVERIFIED"] : [] });
    return alert ? "alerted" : "passed";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("analyze failed", mint, msg);
    await db.from("scanned_tokens").update({ status: "error", error: msg.slice(0, 500) }).eq("mint", mint);
    return "error";
  }
}
