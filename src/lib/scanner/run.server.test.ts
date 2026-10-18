import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ updates: [] as { table: string; payload: Record<string, unknown> }[], inserts: [] as { table: string; payload: Record<string, unknown> }[], activity: vi.fn(), ai: vi.fn(), telegram: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {
  rpc: async () => ({ data: true }),
  from: (table: string) => {
    let operation = "select";
    const q: Record<string, unknown> = {};
    for (const key of ["select", "eq", "gte", "in", "order", "limit"]) q[key] = () => q;
    q.single = async () => ({ data: { max_coins_per_run: 1 } });
    q.update = (payload: Record<string, unknown>) => { operation = "update"; h.updates.push({ table, payload }); return q; };
    q.upsert = (payload: Record<string, unknown>) => { operation = "upsert"; h.inserts.push({ table, payload }); return q; };
    q.insert = (payload: Record<string, unknown>) => { operation = "insert"; h.inserts.push({ table, payload }); return q; };
    q.then = (resolve: (r: unknown) => unknown) => resolve({ data: table === "scanned_tokens" && operation === "update" ? [{ mint: "mint" }] : [], error: null });
    return q;
  },
} }));
vi.mock("./discovery.server", () => ({ loadHeliusBudget: async () => ({ monthlyBudget: 1000, usedThisMonth: 0, maxTx: 30 }),
  discoverLaunches: async () => ({ found: [{ mint: "mint" }], provider: "helius", retrieved: 1, credits: 2 }) }));
vi.mock("./data.server", () => ({ rpcUsage: { total: 2, byMethod: {} }, rpcBudget: { skipped: 0, byMethod: {} }, setRpcBudget: vi.fn(), resetRpcUsage: vi.fn(),
  fetchPairs: async () => { throw new Error("HTTP 429"); }, fetchHolderPcts: vi.fn(), fetchDexPaid: vi.fn() }));
vi.mock("./market.server", () => ({
  fetchSolUsd: async () => ({ value: 100, source: "ref", at: new Date().toISOString() }),
  fetchOnchainBatch: async () => new Map([["mint", { mintRes: { ok: true, info: { mintAuthority: null, freezeAuthority: null, supply: 100, extensions: [], transferFeeBps: 0 } }, curve: { complete: false } }]]),
  buildMarketData: () => ({ priceSol: { value: null, source: "chain", at: null }, priceUsd: { value: null, source: "chain", at: null }, activity: null, missing: ["No price"] }),
  toPairLike: () => ({ dexId: "pumpfun", pairAddress: "curve", baseToken: { address: "mint", name: "Real coin", symbol: "REAL" } }),
  attachActivity: (...a: unknown[]) => h.activity(...a),
}));
vi.mock("./ai.server", () => ({ AiGatewayError: class extends Error {}, runAiAgents: h.ai }));
vi.mock("./telegram.server", () => ({ sendTelegram: h.telegram }));
vi.mock("./forensics.server", () => ({ investigateWallets: vi.fn() }));
vi.mock("./outcomes.server", () => ({ collectDueObservations: async () => ({ recorded: 0 }), predictionMarket: vi.fn(), recordPrediction: vi.fn() }));
import { runScan } from "./run.server";
beforeEach(() => { h.updates.length = 0; h.inserts.length = 0; h.ai.mockClear(); h.telegram.mockClear(); h.activity.mockImplementation(async (...a) => a[4]); });
describe("missing market scan flow", () => {
  it("saves discovered coins, survives indexed failure and prevents analysis or Telegram when price is missing", async () => {
    const summary = await runScan();
    expect(summary).toContain("indexed market unavailable");
    const result = h.updates.find((r) => r.table === "scanned_tokens" && r.payload.status === "unanalyzed");
    expect(result?.payload.verdict).toBe("UNANALYZED — MISSING MARKET DATA");
    expect(result?.payload.score).toBeNull();
    expect(h.ai).not.toHaveBeenCalled(); expect(h.telegram).not.toHaveBeenCalled();
    expect(h.inserts.some((r) => r.table === "scan_runs")).toBe(true);
    expect(h.updates.some((r) => r.table === "scanner_state" && r.payload.lock_until === null)).toBe(true);
  });
});