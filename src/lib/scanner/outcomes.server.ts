import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchPairs, type DexPair } from "./data.server";
import { fetchOutcomePrices } from "./market.server";
import { buildObservation, buildPrediction, marketPointFromPair, scheduleObservations, type CheckpointKey, type PredictionInput } from "./outcomes";

/** Insert the frozen prediction once; a repeat for the same discovery event is ignored. */
export async function recordPrediction(input: PredictionInput) {
  try {
    const row = buildPrediction(input);
    const { data, error } = await supabaseAdmin
      .from("predictions")
      .upsert({ ...row, snapshot: row.snapshot as unknown as Json }, { onConflict: "discovery_key", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(error.message);
    const id = data?.[0]?.id;
    if (!id) return; // already recorded
    await supabaseAdmin
      .from("prediction_observations")
      .upsert(scheduleObservations(input.detectedAt).map((o) => ({ ...o, prediction_id: id })), { onConflict: "prediction_id,checkpoint", ignoreDuplicates: true });
  } catch (e) {
    console.error(JSON.stringify({ evt: "prediction_record_failed", mint: input.mint, error: e instanceof Error ? e.message : String(e) }));
  }
}

export function predictionMarket(pair: DexPair) {
  return { ...marketPointFromPair(pair), txns: pair.txns ?? {} };
}

/** Due prices: batched Helius curves first, indexed backup for missing/graduated curves. */
export async function collectDueObservations(limit = 60) {
  const db = supabaseAdmin;
  const now = new Date();
  const { data: due, error } = await db
    .from("prediction_observations")
    .select("id,checkpoint,due_at,predictions(mint,initial_price_usd)")
    .eq("status", "pending")
    .lte("due_at", now.toISOString())
    .order("due_at")
    .limit(limit);
  if (error) throw new Error(`observations query failed: ${error.message}`);
  if (!due?.length) return { recorded: 0, unavailable: 0, retry: 0 };

  type Row = (typeof due)[number] & { predictions: { mint: string; initial_price_usd: number | null } | null };
  const rows = due as Row[];
  const mints = [...new Set(rows.map((r) => r.predictions?.mint).filter((m): m is string => !!m))];
  const prices = await fetchOutcomePrices(mints);
  let pairs = new Map<string, DexPair>();
  let fetchError: string | undefined;
  try {
    pairs = await fetchPairs(mints.filter((mint) => !prices.get(mint)?.point));
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }
  let recorded = 0;
  let unavailable = 0;
  let retry = 0;
  for (const r of rows) {
    const mint = r.predictions?.mint;
    const pair = mint ? pairs.get(mint) : undefined;
    const onchain = mint ? prices.get(mint) : undefined;
    const point = onchain?.point ?? (pair ? marketPointFromPair(pair) : null);
    const obs = buildObservation({
      checkpoint: r.checkpoint as CheckpointKey,
      dueAt: new Date(r.due_at),
      now,
      initialPrice: r.predictions?.initial_price_usd ?? null,
      point,
      fetchError: point?.priceUsd ? undefined : (fetchError ?? onchain?.reason ?? "No usable price returned"),
    });
    if (obs.status === "retry") {
      retry++;
      await db.from("prediction_observations").update({ reason: `Retrying — last attempt: ${obs.reason}` }).eq("id", r.id).eq("status", "pending");
      continue;
    }
    const { error: saveError } = await db.from("prediction_observations").update({ ...obs,
      ...(obs.status === "recorded" ? { reason: onchain?.point ? onchain.reason : "DexScreener indexed backup; observed now, not historical" } : {}) }).eq("id", r.id).eq("status", "pending");
    if (saveError) throw new Error("Could not save outcome observation");
    if (obs.status === "recorded") recorded++;
    else unavailable++;
  }
  return { recorded, unavailable, retry, ...(fetchError ? { fetchError: fetchError.slice(0, 120) } : {}) };
}
