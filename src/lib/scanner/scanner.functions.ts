import { createServerFn } from "@tanstack/react-start";

export const getDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [{ data: state }, { data: tokens }, { data: runs }] = await Promise.all([
    supabaseAdmin.from("scanner_state").select("paused_reason,last_run_at,last_run_summary,max_coins_per_run").eq("id", 1).single(),
    supabaseAdmin
      .from("scanned_tokens")
      .select("mint,name,symbol,status,score,verdict,reports,alert_text,error,created_at")
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin.from("scan_runs").select("run_at,coins_checked,rpc_calls").gte("run_at", since).order("run_at", { ascending: false }).limit(400),
  ]);
  return {
    state,
    tokens: (tokens ?? []).map((t) => ({ ...t, reports: JSON.stringify(t.reports ?? {}) })),
    chatIdSet: !!process.env["TELEGRAM_CHAT_ID"],
    credits: summarizeCredits(runs ?? []),
  };
});

let lastTest = 0;
export const sendTestAlert = createServerFn({ method: "POST" }).handler(async () => {
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

export const resumeScanner = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("scanner_state").update({ paused_reason: null }).eq("id", 1);
  return { ok: true };
});

let lastManual = 0;
export const scanNow = createServerFn({ method: "POST" }).handler(async () => {
  if (Date.now() - lastManual < 30_000) return { ok: false, summary: "Please wait 30 seconds between manual scans." };
  lastManual = Date.now();
  try {
    const { runScan } = await import("./run.server");
    return { ok: true, summary: await runScan() };
  } catch (e) {
    return { ok: false, summary: e instanceof Error ? e.message : String(e) };
  }
});

export type RunRow = { run_at: string; coins_checked: number; rpc_calls: number };
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
    recent: runs.slice(0, 10),
  };
}

export const setMaxCoins = createServerFn({ method: "POST" })
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
