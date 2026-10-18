import { describe, expect, it } from "vitest";
import { approvalDecision } from "./approval";
import { analyzeSecurity, analyzeWallets } from "./rules";
import { analyzeForensics } from "./forensics";
import { summarizeActivity } from "./onchain";
const now = Date.now();
const security = analyzeSecurity({ mintAuthority: null, freezeAuthority: null, extensions: [], transferFeeBps: 0, dexId: "pumpfun" }, "pumpfun");
const f = analyzeForensics({ mint: "m", supply: 1, createTx: null, historyComplete: false, earlyTxs: null, excludeOwners: [], fundings: [], fundingFailed: [], creatorHistory: null, notes: [] });
const wallet = analyzeWallets({ pcts: [1], excluded: 1 }, undefined, { ...f, status: "COMPLETE", redFlags: [], suspected: [], snipers: [] });
wallet.risk = "Safe";
const price = { value: 1, source: "chain", at: new Date(now).toISOString() };
const market = { priceSol: price, priceUsd: price, activity: summarizeActivity([], [], now / 1000, 300) };
describe("mandatory Telegram approval", () => {
  it("requires complete wallet investigations even when holder data succeeded", () => {
    expect(approvalDecision(95, security, { ...wallet, forensics: { ...f, status: "PARTIAL" } }, market, true, now).approved).toBe(false);
    expect(approvalDecision(95, security, { ...wallet, forensics: f }, market, true, now).approved).toBe(false);
  });
  it("requires verified safety and holders", () => {
    expect(approvalDecision(95, analyzeSecurity(null, "pumpfun"), wallet, market, true, now).approved).toBe(false);
    expect(approvalDecision(95, security, { ...wallet, verified: false }, market, true, now).approved).toBe(false);
  });
  it("never approves missing market data or partial trade coverage", () => {
    expect(approvalDecision(95, security, wallet, { ...market, activity: null }, true, now).approved).toBe(false);
    expect(approvalDecision(95, security, wallet, { ...market, activity: { ...market.activity, sampleComplete: false } }, true, now).approved).toBe(false);
  });
  it("uses the existing strong-opportunity benchmark without altering scores", () => {
    expect(approvalDecision(69, security, wallet, market, true, now).approved).toBe(false);
    expect(approvalDecision(70, security, wallet, market, true, now).approved).toBe(true);
  });
  it("blocks an unverified active curve regardless of score", () => {
    expect(approvalDecision(95, security, wallet, market, false, now).approved).toBe(false);
  });
});