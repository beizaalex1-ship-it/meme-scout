import { createServerFn } from "@tanstack/react-start";

export const getDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: state }, { data: tokens }] = await Promise.all([
    supabaseAdmin.from("scanner_state").select("paused_reason,last_run_at,last_run_summary").eq("id", 1).single(),
    supabaseAdmin
      .from("scanned_tokens")
      .select("mint,name,symbol,status,score,verdict,reports,alert_text,error,created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  return {
    state,
    tokens: (tokens ?? []).map((t) => ({ ...t, reports: JSON.stringify(t.reports ?? {}) })),
    chatIdSet: !!process.env["TELEGRAM_CHAT_ID"],
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
