import { afterEach, describe, expect, it } from "vitest";
import { affordableCoins, planHeliusBudget, RESERVE_PER_COIN } from "./discovery";
import { resetRpcUsage, rpc, RpcError, rpcBudget, rpcUsage, setRpcBudget } from "./data.server";
import { analyzeSecurity } from "./rules";

const okFetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }))) as unknown as typeof fetch;
const opts = { urls: ["https://example.invalid"], fetchImpl: okFetch, retries: 0 };
afterEach(() => { setRpcBudget(null); resetRpcUsage(); });

describe("shared Helius budget", () => {
  it("blocks every Helius call once the scan allowance is spent, without sending it", async () => {
    resetRpcUsage();
    setRpcBudget(2);
    await rpc("getTransaction", [], opts);
    await rpc("getTokenLargestAccounts", [], opts);
    await expect(rpc("getSignaturesForAddress", [], opts)).rejects.toMatchObject({ kind: "budget" });
    expect(rpcUsage.total).toBe(2);
    expect(rpcBudget.skipped).toBe(1);
  });

  it("discovery leaves the reserve for wallet/safety checks", () => {
    // 200 credits left, 3 coins need 105 reserved: discovery may use at most 93.
    const d = planHeliusBudget({ monthlyBudget: 1000, usedThisMonth: 800, maxCoins: 3, maxTx: 500 });
    expect(d.allowedTx).toBe(1000 - 800 - 3 * RESERVE_PER_COIN - 2);
    // After discovery spends that, all 3 coins are still affordable.
    expect(affordableCoins(200, 1 + d.allowedTx, 3)).toBe(3);
  });

  it("when nearly exhausted, discovery stops first and fewer coins get full checks", () => {
    const d = planHeliusBudget({ monthlyBudget: 1000, usedThisMonth: 950, maxCoins: 3, maxTx: 30 });
    expect(d.allowedTx).toBe(0);
    expect(affordableCoins(50, 0, 3)).toBe(1);
    expect(affordableCoins(20, 0, 3)).toBe(0);
  });

  it("a budget-blocked safety lookup is UNVERIFIED, never PASS", () => {
    const err = new RpcError("budget", "getMultipleAccounts skipped: Helius budget reached");
    const sec = analyzeSecurity(null, "pumpfun", err.message);
    expect(sec.verdict).toBe("UNVERIFIED");
  });
});
