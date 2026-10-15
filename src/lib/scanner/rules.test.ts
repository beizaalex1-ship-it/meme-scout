import { describe, expect, it } from "vitest";
import {
  adjustScoreForEvidence,
  analyzeSecurity,
  analyzeWallets,
  computeHolderPcts,
  isSecurityApproved,
  shouldAlert,
  shouldReject,
} from "./rules";

const base = { mintAuthority: null, freezeAuthority: null, extensions: [], transferFeeBps: 0, dexId: "pumpswap" };
const h = (pcts: number[]) => ({ pcts, excluded: 0 });

describe("scanner rules", () => {
  it("sends every analyzed coin (score 1+)", () => {
    expect(shouldAlert(1)).toBe(true);
    expect(shouldAlert(30)).toBe(true);
  });

  it("flags top 10 holders over 30% as High Risk", () => {
    expect(analyzeWallets(h([10, 8, 5, 3, 2, 1, 1, 0.5, 0.3, 0.2])).risk).toBe("High Risk");
    expect(analyzeWallets(h([5, 4, 3, 3, 3, 3, 3, 2, 2, 2])).risk).not.toBe("High Risk");
  });

  it("treats missing holder data as Unverified, not Safe", () => {
    const w = analyzeWallets(null, "HTTP 403");
    expect(w.risk).toBe("Unverified");
    expect(w.verified).toBe(false);
    expect(w.top10Pct).toBeNull();
  });

  it("excludes the bonding curve / pool account from holder concentration", () => {
    const res = computeHolderPcts(
      [
        { address: "curveAta", uiAmount: 800_000_000, owner: "CURVE" },
        { address: "a", uiAmount: 50_000_000, owner: "w1" },
        { address: "b", uiAmount: 20_000_000, owner: "w2" },
      ],
      1_000_000_000,
      ["CURVE"],
    );
    expect(res).toEqual({ pcts: [5, 2], excluded: 1 });
  });

  it("refuses holder results when an owner can't be resolved", () => {
    expect(computeHolderPcts([{ address: "a", uiAmount: 1, owner: null }], 100, [])).toBeNull();
    expect(computeHolderPcts([{ address: "a", uiAmount: 1, owner: "x" }], 0, [])).toBeNull();
  });

  it("fails security on a verified critical issue", () => {
    expect(analyzeSecurity({ ...base, mintAuthority: "X" }, "pumpswap").verdict).toBe("FAIL");
    expect(analyzeSecurity({ ...base, freezeAuthority: "X" }, "pumpswap").verdict).toBe("FAIL");
    expect(analyzeSecurity({ ...base, transferFeeBps: 500 }, "pumpswap").verdict).toBe("FAIL");
    expect(analyzeSecurity(base, "pumpswap").verdict).toBe("PASS");
  });

  it("never passes security when the mint lookup failed", () => {
    const s = analyzeSecurity(null, "pumpfun", "HTTP 403");
    expect(s.verdict).toBe("UNVERIFIED");
    expect(s.mintAuthorityDisabled).toBeNull();
  });

  it("rejects on security FAIL or High Risk holders", () => {
    const fail = analyzeSecurity({ ...base, mintAuthority: "X" }, "pumpswap");
    const pass = analyzeSecurity(base, "pumpswap");
    expect(shouldReject(fail, analyzeWallets(h([1])))).toBe(true);
    expect(shouldReject(pass, analyzeWallets(h([20, 15])))).toBe(true);
    expect(shouldReject(pass, analyzeWallets(h([2, 2])))).toBe(false);
  });

  it("never marks unverified tokens as security-approved", () => {
    const unv = analyzeSecurity(null, "pumpfun");
    const pass = analyzeSecurity(base, "pumpswap");
    expect(isSecurityApproved(unv, analyzeWallets(h([2])))).toBe(false);
    expect(isSecurityApproved(pass, analyzeWallets(null))).toBe(false);
    expect(isSecurityApproved(pass, analyzeWallets(h([2])))).toBe(true);
  });

  it("caps the Opportunity Score when evidence is missing", () => {
    const pass = analyzeSecurity(base, "pumpswap");
    const unv = analyzeSecurity(null, "pumpfun");
    expect(adjustScoreForEvidence(90, unv, analyzeWallets(h([2])))).toBe(40);
    expect(adjustScoreForEvidence(90, pass, analyzeWallets(null))).toBe(60);
    expect(adjustScoreForEvidence(90, pass, analyzeWallets(h([2])))).toBe(90);
  });
});

import { summarizeCredits } from "./scanner.functions";
describe("Helius credit summary", () => {
  it("averages per scan and per coin and projects 8,640 scans a month", () => {
    const c = summarizeCredits([
      { run_at: "a", coins_checked: 3, rpc_calls: 90 },
      { run_at: "b", coins_checked: 1, rpc_calls: 30 },
    ]);
    expect(c).toMatchObject({ calls24h: 120, avgPerRun: 60, avgPerCoin: 30, projected30d: 518_400 });
  });
  it("shows no projection without data", () => {
    expect(summarizeCredits([]).projected30d).toBeNull();
  });
});
