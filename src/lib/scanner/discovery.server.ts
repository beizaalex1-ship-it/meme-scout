import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { discoverGecko, rpc, rpcUsage } from "./data.server";
import { extractLaunchMint, planHeliusBudget, PUMP_LAUNCH_AUTHORITY, selectSignatures, SIGNATURE_LIMIT, type RawLaunchTx, type RawSig } from "./discovery";

export async function loadHeliusBudget() {
  const db = supabaseAdmin;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data: state, error: stateError } = await db.from("scanner_state").select("helius_monthly_budget,helius_discovery_max_tx").eq("id", 1).single();
  const used: number[] = [];
  if (stateError || !state) throw new Error("Helius budget settings unavailable; no RPC requests permitted");
  for (let offset = 0; ; offset += 500) {
    const { data: runs, error } = await db.from("scan_runs").select("rpc_calls").gte("run_at", monthStart).order("run_at").range(offset, offset + 499);
    if (error || !runs) throw new Error("Helius usage unavailable; no RPC requests permitted");
    used.push(...runs.map((r) => r.rpc_calls ?? 0));
    if (runs.length < 500) break;
  }
  return {
    monthlyBudget: state.helius_monthly_budget,
    usedThisMonth: used.reduce((a, n) => a + n, 0),
    maxTx: state.helius_discovery_max_tx,
  };
}

export type DiscoveryResult = {
  found: { mint: string; description: string | undefined }[];
  provider: "geckoterminal" | "helius" | "none";
  retrieved: number;
  eligible: number;
  failures: number;
  credits: number;
  note: string | null;
};

/** GeckoTerminal first (free). Helius launch-account fallback only when GeckoTerminal is unavailable. */
export async function discoverLaunches(maxAgeMin: number, maxCoins: number, budgetIn?: { monthlyBudget: number; usedThisMonth: number; maxTx: number }): Promise<DiscoveryResult> {
  const g = await discoverGecko(maxAgeMin);
  if (g.ok) return { found: g.mints, provider: "geckoterminal", retrieved: g.mints.length, eligible: g.mints.length, failures: 0, credits: 0, note: null };

  const db = supabaseAdmin;
  const b = budgetIn ?? (await loadHeliusBudget());
  const budget = planHeliusBudget({ ...b, maxCoins });
  const base = { found: [], retrieved: 0, eligible: 0, failures: 0, credits: 0 };
  if (!budget.allowedTx) {
    console.error(JSON.stringify({ evt: "helius_discovery_skipped", reason: budget.reason }));
    return { ...base, provider: "none", note: `GeckoTerminal unavailable (${g.error}); Helius skipped: ${budget.reason}` };
  }

  const start = rpcUsage.total;
  let sigs: RawSig[];
  try {
    sigs = await rpc<RawSig[]>("getSignaturesForAddress", [PUMP_LAUNCH_AUTHORITY, { limit: SIGNATURE_LIMIT, commitment: "confirmed" }]);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
    console.error(JSON.stringify({ evt: "helius_discovery_failed", error: msg }));
    return { ...base, provider: "helius", failures: 1, credits: rpcUsage.total - start, note: `Helius launch listing failed: ${msg}` };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const recent = sigs.filter((s) => typeof s.blockTime === "number" && nowSec - s.blockTime <= maxAgeMin * 60).map((s) => s.signature);
  const { data: seenRows } = recent.length ? await db.from("helius_launches").select("signature").in("signature", recent) : { data: [] };
  const sel = selectSignatures(sigs, new Set((seenRows ?? []).map((r) => r.signature)), nowSec, maxAgeMin, budget.allowedTx);

  const found: DiscoveryResult["found"] = [];
  const rows: { signature: string; mint: string | null; block_time: string | null; status: string }[] = [];
  let failures = 0;
  for (const s of sel.picked) {
    let parsed;
    try {
       parsed = extractLaunchMint(await rpc<RawLaunchTx>("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], { retries: 0 }));
    } catch (e) {
      failures++; // not recorded as seen, so it is retried next scan while still in the window
      continue;
    }
    const bt = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null;
    if (parsed.ok) {
      rows.push({ signature: s.signature, mint: parsed.mint, block_time: bt, status: "launch" });
      if (parsed.mint.endsWith("pump")) found.push({ mint: parsed.mint, description: undefined });
    } else {
      failures++;
      rows.push({ signature: s.signature, mint: null, block_time: bt, status: `ignored: ${parsed.reason}` });
    }
  }
  if (rows.length) await db.from("helius_launches").upsert(rows, { onConflict: "signature", ignoreDuplicates: true });
  const credits = rpcUsage.total - start;
  console.log(JSON.stringify({ evt: "helius_discovery", listed: sigs.length, eligible: sel.eligible, fetched: sel.picked.length, launches: found.length, failures, credits }));
  return {
    found: [...new Map(found.map((f) => [f.mint, f])).values()],
    provider: "helius",
    retrieved: sel.picked.length,
    eligible: sel.eligible,
    failures,
    credits,
    note: `GeckoTerminal unavailable (${g.error}); Helius fallback used`,
  };
}
