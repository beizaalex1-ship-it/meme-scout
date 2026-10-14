import { describe, expect, it } from "vitest";
import { analyzeSecurity, analyzeWallets, shouldAlert, shouldReject } from "./rules";

const base = { mintAuthority: null, freezeAuthority: null, extensions: [], transferFeeBps: 0, dexId: "pumpswap" };

describe("scanner rules", () => {
  it("alerts only at Opportunity Score 70 or higher", () => {
    expect(shouldAlert(70)).toBe(true);
    expect(shouldAlert(69)).toBe(false);
  });

  it("flags insiders holding over 30% as High Risk", () => {
    expect(analyzeWallets([10, 8, 5, 3, 2, 1, 1, 0.5, 0.3, 0.2]).risk).toBe("High Risk");
    expect(analyzeWallets([5, 4, 3, 3, 3, 3, 3, 2, 2, 2]).risk).not.toBe("High Risk");
  });

  it("fails security when mint or freeze authority is enabled", () => {
    expect(analyzeSecurity({ ...base, mintAuthority: "X" }).verdict).toBe("FAIL");
    expect(analyzeSecurity({ ...base, freezeAuthority: "X" }).verdict).toBe("FAIL");
    expect(analyzeSecurity(base).verdict).toBe("PASS");
  });

  it("rejects automatically on security FAIL or High Risk holders", () => {
    const fail = analyzeSecurity({ ...base, mintAuthority: "X" });
    const pass = analyzeSecurity(base);
    expect(shouldReject(fail, analyzeWallets([1]))).toBe(true);
    expect(shouldReject(pass, analyzeWallets([20, 15]))).toBe(true);
    expect(shouldReject(pass, analyzeWallets([2, 2]))).toBe(false);
  });
});
