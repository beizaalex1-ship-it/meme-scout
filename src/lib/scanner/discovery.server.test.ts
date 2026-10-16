import { beforeEach, describe, expect, it, vi } from "vitest";

const gecko = vi.fn();
const rpc = vi.fn();
const usage = { total: 0 };
vi.mock("./data.server", () => ({ discoverGecko: (...a: unknown[]) => gecko(...a), rpc: (...a: unknown[]) => { usage.total++; return rpc(...a); }, rpcUsage: usage }));
const upsert = vi.fn(async () => ({}));
vi.mock("@/integrations/supabase/client.server", () => {
  const q = (data: unknown) => {
    const o: Record<string, unknown> = {};
    for (const k of ["select", "eq", "gte", "limit", "in"]) o[k] = () => o;
    o["single"] = async () => ({ data });
    o["then"] = (r: (v: unknown) => unknown) => r({ data: Array.isArray(data) ? data : [] });
    return o;
  };
  return { supabaseAdmin: { from: (t: string) => (t === "helius_launches" ? { ...q([]), upsert } : t === "scanner_state" ? q({ helius_monthly_budget: 1_000_000, helius_discovery_max_tx: 30 }) : q([])) } };
});

const { discoverLaunches } = await import("./discovery.server");
const { PUMP_PROGRAM_ID } = await import("./forensics");
const MINT = "AGmksq6hBGQi4bU5SFy3VH6gYy2R1YYKxeCiniLUpump";

beforeEach(() => { gecko.mockReset(); rpc.mockReset(); usage.total = 0; });

describe("discoverLaunches", () => {
  it("uses GeckoTerminal when it works and spends no Helius credits", async () => {
    gecko.mockResolvedValue({ ok: true, error: null, mints: [{ mint: MINT }] });
    const r = await discoverLaunches(10, 3);
    expect(r.provider).toBe("geckoterminal");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("falls back to Helius when GeckoTerminal is rate-limited", async () => {
    gecko.mockResolvedValue({ ok: false, error: "HTTP 429", mints: [] });
    const now = Math.floor(Date.now() / 1000);
    rpc.mockImplementation(async (m: string) =>
      m === "getSignaturesForAddress"
        ? [{ signature: "s1", blockTime: now - 120 }, { signature: "s2", blockTime: now - 180 }]
        : m === "getTransaction" && rpc.mock.calls.length === 2
          ? { meta: { err: null, logMessages: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: CreateV2"], postTokenBalances: [{ mint: MINT }] }, transaction: { message: { accountKeys: [{ pubkey: "P", signer: true }, { pubkey: MINT, signer: true }] } } }
          : { garbage: true },
    );
    const r = await discoverLaunches(10, 3);
    expect(r.provider).toBe("helius");
    expect(r.found.map((f) => f.mint)).toEqual([MINT]);
    expect(r.failures).toBe(1); // malformed tx counted, not crashed
    expect(r.credits).toBe(3);
  });
  it("reports a Helius outage instead of throwing", async () => {
    gecko.mockResolvedValue({ ok: false, error: "HTTP 429", mints: [] });
    rpc.mockRejectedValue(new Error("HTTP 503"));
    const r = await discoverLaunches(10, 3);
    expect(r.found).toEqual([]);
    expect(r.note).toMatch(/failed/);
  });
});
