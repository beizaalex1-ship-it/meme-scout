import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { formatAlert } from "./alert";
import { AiGatewayError, runAiAgents } from "./ai.server";
import { resetRpcUsage, rpcUsage, rpcBudget, setRpcBudget, fetchHolderPcts, type MintResult, fetchPairs, type DexPair, fetchDexPaid } from "./data.server";
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
import { discoverLaunches, loadHeliusBudget, type DiscoveryResult } from "./discovery.server";
import { affordableCoins } from "./discovery";
import { predictionMarket, recordPrediction } from "./outcomes.server";
import { fetchOnchainBatch, fetchSolUsd, buildMarketData, attachActivity, toPairLike, type MarketData } from "./market.server";
import { marketReadiness, UNANALYZED_LABEL } from "./onchain";
import { approvalDecision } from "./approval";

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
  let disc: DiscoveryResult | null = null;
  let budgetNote = "";
  try {
    // One shared guard for every Helius call this scan (discovery, safety, holders, wallet forensics).
    const hb = await loadHeliusBudget();
    const allowance = Math.max(0, hb.monthlyBudget - hb.usedThisMonth);
    setRpcBudget(allowance);
    disc = await discoverLaunches(MAX_LAUNCH_AGE_MIN, maxCoins, hb);
    const found = disc.found;
    const { data: waiting } = await db.from("scanned_tokens").select("mint,created_at")
      .eq("status", "unanalyzed").gte("created_at", new Date(Date.now() - MAX_LAUNCH_AGE_MIN * 60_000).toISOString());
    const queue = [...new Map([...found, ...(waiting ?? []).map((r) => ({ mint: r.mint, description: undefined }))].map((r) => [r.mint, r])).values()];
    const inList = queue.length ? queue.map((f) => f.mint) : ["-"];
    const [{ data: known }, { data: knownPred }] = await Promise.all([
      db.from("scanned_tokens").select("mint,status").in("mint", inList),
      db.from("predictions").select("mint").in("mint", inList),
    ]);
    const knownSet = new Set([...(known ?? []).filter((k) => k.status !== "unanalyzed"), ...(knownPred ?? [])].map((k) => k.mint));
    const fresh = queue.filter((f) => !knownSet.has(f.mint));
    if (fresh.length) {
      const { error } = await db.from("scanned_tokens").upsert(fresh.map((f) => ({ mint: f.mint, status: "unanalyzed", verdict: UNANALYZED_LABEL,
        reports: { marketData: { missing: ["Awaiting market and safety checks"], analyzable: false }, approval: { approved: false } } })), { onConflict: "mint", ignoreDuplicates: true });
      if (error) throw new Error("Could not save discovered coins");
    }
    let pairs = new Map<string, DexPair>();
    let marketFailed = "";
    const dexAt = new Date().toISOString(); // conservative request start, including HTTP cache age below
    try { pairs = await fetchPairs(fresh.map((f) => f.mint)); }
    catch (e) {
      marketFailed = e instanceof Error ? e.message.slice(0, 120) : "Indexed market unavailable";
      console.error(JSON.stringify({ evt: "market_data_failed", stage: "discovery", coins: fresh.length, error: marketFailed }));
    }
    const solUsd = fresh.length ? await fetchSolUsd() : { value: null, source: "none", at: null };
    const onchain = await fetchOnchainBatch(fresh.map((f) => f.mint));
    const prelim = fresh.map((f) => {
      const oc = onchain.get(f.mint);
      const dex = pairs.get(f.mint);
      const mintRes: MintResult = oc?.mintRes ?? { ok: false, reason: "not returned" };
      // Dex cache is at most 30 seconds old: do not relabel its receipt as a fresh source read.
      const md = buildMarketData(oc, dex, new Date(Date.parse(dexAt) - 30_000).toISOString(), solUsd, mintRes.ok ? mintRes.info.supply : null);
      const pair = toPairLike(f.mint, oc, dex, md);
      const quality = (dex?.txns?.["m5"]?.buys ?? 0) + (dex?.txns?.["m5"]?.sells ?? 0);
      return { ...f, pair, mintRes, md, oc, dex, quality };
    });
    // Credits optimizer: one batched Helius request checks every candidate's mint, then only
    // coins with verified PASS safety data get the expensive holder/forensics/AI checks.
    const withSec = prelim.map((c) => {
      const m = c.mintRes;
      const security = m.ok ? analyzeSecurity({ ...m.info, dexId: c.pair.dexId }, c.pair.dexId) : analyzeSecurity(null, c.pair.dexId, m.reason);
      return { ...c, security };
    });
    const coinsCap = affordableCoins(allowance, rpcUsage.total, maxCoins);
    if (coinsCap < maxCoins) {
      budgetNote = `Helius budget: only ${coinsCap} of ${maxCoins} coins affordable (${(allowance - rpcUsage.total).toLocaleString("en-US")} credits left this month)`;
      console.warn(JSON.stringify({ evt: "helius_budget_limit", coinsCap, maxCoins, left: allowance - rpcUsage.total }));
    }
    const plan = planCandidates(withSec.map((c) => ({ item: c, quality: c.quality, security: c.security })), coinsCap);
    opt.skippedUnverified = plan.skippedUnverified.length;
    for (const c of [...plan.skippedUnverified, ...plan.overCap]) {
      await db.from("scanned_tokens").update({ name: c.pair.baseToken.name || null, symbol: c.pair.baseToken.symbol || null,
        verdict: UNANALYZED_LABEL, reports: JSON.parse(JSON.stringify({ marketData: c.md, security: c.security,
          approval: { approved: false, reasons: [c.security.verdict !== "PASS" ? "Security UNVERIFIED" : "Per-run credit/coin cap; mandatory checks not run"] } })) }).eq("mint", c.mint);
    }
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
          { onConflict: "mint" },
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

    // A conditional transition claims both new rows and retryable market failures.
    const claimedSet = new Set<string>();
    for (const c of candidates) {
      const { data: claimed, error } = await db.from("scanned_tokens").update({ status: "pending", name: c.pair.baseToken.name || null, symbol: c.pair.baseToken.symbol || null })
        .eq("mint", c.mint).eq("status", "unanalyzed").select("mint");
      if (error) throw new Error("Could not claim coin");
      if (claimed?.length) claimedSet.add(c.mint);
    }

    let alerted = 0;
    let rejected = 0;
    for (const c of candidates.filter((x) => claimedSet.has(x.mint))) {
      analyzedCount++;
      const md = await attachActivity(c.mint, c.oc, c.dex, new Date(Date.parse(dexAt) - 30_000).toISOString(), c.md);
      const pair = toPairLike(c.mint, c.oc, c.dex, md);
      const ready = marketReadiness(md, Date.now());
      if (!ready.analyzable || c.oc?.curve?.complete) {
        await db.from("scanned_tokens").update({ status: "unanalyzed", verdict: UNANALYZED_LABEL, score: null, alert_text: null,
          reports: JSON.parse(JSON.stringify({ marketData: md, security: c.security, approval: { approved: false, reasons: [ready.analyzable ? "Graduated token outside launch scope" : ready.reason] } })) }).eq("mint", c.mint);
        continue;
      }
      const outcome = await analyzeToken(c.mint, pair, c.mintRes, md, !!c.oc?.curve && !c.oc.curve.complete, c.description);
      if (outcome === "holder_rejected") opt.holderRejected++;
      if (outcome === "paused") {
        summary = "Paused after AI access error";
        return summary;
      }
      if (outcome === "alerted") alerted++;
      if (outcome === "rejected" || outcome === "holder_rejected") rejected++;
    }
    summary = `[${disc.provider}${disc.provider === "helius" ? `: ${disc.retrieved} launches read, ${disc.credits} credits` : ""}] Found ${found.length}, new ${fresh.length}, analyzed ${candidates.length}, rejected ${rejected + opt.earlyRejected}, alerted ${alerted}, skipped unverified ${opt.skippedUnverified}${marketFailed ? ` — indexed market unavailable; on-chain fallback attempted` : ""}${budgetNote ? ` — ${budgetNote}` : ""}${rpcBudget.skipped ? ` — ${rpcBudget.skipped} Helius checks skipped (budget), marked UNVERIFIED` : ""}`;
    return summary;
  } finally {
    if (rpcBudget.skipped) console.warn(JSON.stringify({ evt: "helius_budget_summary", skipped: rpcBudget.skipped, byMethod: rpcBudget.byMethod }));
    const { error: runError } = await db.from("scan_runs").insert({
      coins_checked: analyzedCount,
      rpc_calls: rpcUsage.total,
      calls_by_method: { ...rpcUsage.byMethod },
      early_rejected: opt.earlyRejected,
      skipped_unverified: opt.skippedUnverified,
      holder_rejected: opt.holderRejected,
      summary: summary || null,
      discovery_provider: disc?.provider ?? null,
      launches_retrieved: disc?.retrieved ?? null,
      launches_eligible: disc?.eligible ?? null,
      discovery_failures: disc?.failures ?? null,
      discovery_credits: disc?.credits ?? null,
      discovery_note: [disc?.note, budgetNote, rpcBudget.skipped ? `${rpcBudget.skipped} Helius calls blocked by budget: ${JSON.stringify(rpcBudget.byMethod)}` : ""].filter(Boolean).join("; ") || null,
    });
    if (runError) throw new Error("Could not persist Helius usage; scanner lock retained");
    setRpcBudget(null);
    await db
      .from("scanner_state")
      .update({ lock_until: null, last_run_at: new Date().toISOString(), ...(summary ? { last_run_summary: summary } : {}) })
      .eq("id", 1);
  }
}

async function analyzeToken(mint: string, pair: DexPair, mintRes: MintResult, marketData: MarketData, curveVerified: boolean, description?: string) {
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
    // Keep 5-minute sampled activity separate from hour totals; no invented hour volume.
    market.bondingCurvePct = marketData.bondingCurvePct.value ?? market.bondingCurvePct;
    const reports: Record<string, Json> = JSON.parse(JSON.stringify({ hunter, market, marketData, wallet, security, socials }));

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
      ai = await runAiAgents({ hunter, market, marketData, wallet, security, socials });
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
    const approval = approvalDecision(score, security, wallet, marketData, curveVerified, Date.now());
    reports["approval"] = approval;
    const alert = approval.approved && shouldAlert(score);
    if (alert) await sendTelegram(alertText);
    await db
      .from("scanned_tokens")
      .update({
        status: alert ? "alerted" : "passed",
        score,
        verdict: alert ? ai.chief.takeaway : `NOT APPROVED: ${approval.reasons.join("; ")}`,
        reports,
        alert_text: alert ? alertText : null,
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
