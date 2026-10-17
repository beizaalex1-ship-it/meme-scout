import { requireAdmin } from "@/lib/admin-middleware";
import { createServerFn } from "@tanstack/react-start";
import { RESERVE_PER_COIN } from "./discovery";

export const getDashboard = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [{ data: state }, { data: tokens }, { data: runs }, { data: preds }, { data: monthRuns }] = await Promise.all([
    supabaseAdmin.from("scanner_state").select("paused_reason,last_run_at,last_run_summary,max_coins_per_run,helius_monthly_budget,helius_discovery_max_tx").eq("id", 1).single(),
    supabaseAdmin
      .from("scanned_tokens")
      .select("mint,name,symbol,status,score,verdict,reports,alert_text,error,created_at")
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin.from("scan_runs").select("run_at,coins_checked,rpc_calls,early_rejected,skipped_unverified,holder_rejected,discovery_provider,launches_retrieved,launches_eligible,discovery_failures,discovery_credits,discovery_note").gte("run_at", since).order("run_at", { ascending: false }).limit(400),
    supabaseAdmin
      .from("predictions")
      .select("id,mint,name,symbol,detected_at,status,score,wallet_risk,security_verdict,initial_price_usd,prediction_observations(checkpoint,status,observed_at,price_usd,price_change_pct,reason)")
      .order("detected_at", { ascending: false })
      .limit(25),
    supabaseAdmin.from("scan_runs").select("rpc_calls").gte("run_at", monthStart).limit(10000),
  ]);
  return {
    state,
    tokens: (tokens ?? []).map((t) => ({ ...t, reports: JSON.stringify(t.reports ?? {}) })),
    chatIdSet: !!process.env["TELEGRAM_CHAT_ID"],
    credits: summarizeCredits(runs ?? []),
    predictions: preds ?? [],
    monthUsed: (monthRuns ?? []).reduce((a, r) => a + (r.rpc_calls ?? 0), 0),
    costEstimate: { normalMax: 2 + (state?.helius_discovery_max_tx ?? 30) + (state?.max_coins_per_run ?? 3) * 47,
      retryMax: 10 + (state?.helius_discovery_max_tx ?? 30) * 5 + (state?.max_coins_per_run ?? 3) * RESERVE_PER_COIN },
  };
});

let lastTest = 0;
export const sendTestAlert = createServerFn({ method: "POST" }).middleware([requireAdmin]).handler(async () => {
  if (Date.now() - lastTest < 15_000) return { ok: false, error: "Please wait a few seconds between tests." };
  lastTest = Date.now();
  const { formatAlert } = await import("./alert");
  const { sendTelegram } = await import("./telegram.server");
  const text = formatAlert(
    {
      name: "Sample Doge",
      symbol: "SDOGE",
      mint: "SampLe1111111111111111111111111111111111pump",
      score: 82,
      marketCapUsd: 184_500,
      bullets: [
        "Market: High momentum — 1,240 trades/hr, 1.6 buy/sell ratio, graduated to PumpSwap",
        "Social: 8/10, organic meme narrative with active X and Telegram",
        "Wallets: Safe — top 10 hold 14.2%, mint & freeze authority disabled",
      ],
      takeaway: "Strong early setup; watch for sell pressure above $250k MC.",
    },
    true,
  );
  try {
    await sendTelegram(text);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

export const resumeScanner = createServerFn({ method: "POST" }).middleware([requireAdmin]).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("scanner_state").update({ paused_reason: null }).eq("id", 1);
  return { ok: true };
});

let lastManual = 0;
export const scanNow = createServerFn({ method: "POST" }).middleware([requireAdmin]).handler(async () => {
  if (Date.now() - lastManual < 30_000) return { ok: false, summary: "Please wait 30 seconds between manual scans." };
  lastManual = Date.now();
  try {
    const { collectDueObservations } = await import("./outcomes.server");
    await collectDueObservations().catch((e) => console.error("outcome checks failed", e));
    const { runScan } = await import("./run.server");
    return { ok: true, summary: await runScan() };
  } catch (e) {
    return { ok: false, summary: e instanceof Error ? e.message : String(e) };
  }
});

export type RunRow = { run_at: string; coins_checked: number; rpc_calls: number; discovery_provider?: string | null; launches_retrieved?: number | null; launches_eligible?: number | null; discovery_failures?: number | null; discovery_credits?: number | null; discovery_note?: string | null; early_rejected?: number; skipped_unverified?: number; holder_rejected?: number };
/** Approx. credits a full check costs (holders + forensics), used to estimate savings. */
export const FULL_CHECK_CREDITS = 30;
/** Estimated Helius credits (≈1 per standard RPC call). */
export function summarizeCredits(runs: RunRow[]) {
  const calls24h = runs.reduce((a, r) => a + r.rpc_calls, 0);
  const coins24h = runs.reduce((a, r) => a + r.coins_checked, 0);
  const avgPerRun = runs.length ? Math.round(calls24h / runs.length) : null;
  return {
    runs24h: runs.length,
    calls24h,
    coins24h,
    avgPerRun,
    avgPerCoin: coins24h ? Math.round(calls24h / coins24h) : null,
    /** if the 5-minute schedule runs all month (8,640 runs) at the 24h average */
    projected30d: avgPerRun === null ? null : avgPerRun * 8640,
    earlyRejected24h: runs.reduce((a, r) => a + (r.early_rejected ?? 0), 0),
    skipped24h: runs.reduce((a, r) => a + (r.skipped_unverified ?? 0), 0),
    holderRejected24h: runs.reduce((a, r) => a + (r.holder_rejected ?? 0), 0),
    /** rough: each early reject / skip avoided a full check */
    estSaved24h: runs.reduce((a, r) => a + ((r.early_rejected ?? 0) + (r.skipped_unverified ?? 0) + (r.holder_rejected ?? 0)) * FULL_CHECK_CREDITS, 0),
    recent: runs.slice(0, 10),
  };
}

export const setMaxCoins = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { value: number }) => {
    const v = Math.round(Number(d.value));
    if (!Number.isFinite(v) || v < 1 || v > 10) throw new Error("Choose between 1 and 10 coins");
    return { value: v };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("scanner_state").update({ max_coins_per_run: data.value }).eq("id", 1);
    return { ok: true };
  });

export const setHeliusLimits = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { monthlyBudget: number; maxTx: number }) => {
    const b = Math.round(Number(d.monthlyBudget));
    const t = Math.round(Number(d.maxTx));
    if (!Number.isFinite(b) || b < 1000 || b > 100_000_000) throw new Error("Monthly budget must be 1,000–100,000,000");
    if (!Number.isFinite(t) || t < 0 || t > 100) throw new Error("Per-scan discovery limit must be 0–100");
    return { monthlyBudget: b, maxTx: t };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("scanner_state").update({ helius_monthly_budget: data.monthlyBudget, helius_discovery_max_tx: data.maxTx }).eq("id", 1);
    return { ok: true };
  });
