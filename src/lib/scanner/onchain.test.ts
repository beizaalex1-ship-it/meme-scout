import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bondingCurveAddress, decodeBondingCurve, curvePriceSol, marketReadiness, parseCurveTrade, summarizeActivity } from "./onchain";

export function curveFixture(complete = false) {
  const d = new Uint8Array(49);
  d.set(sha256(new TextEncoder().encode("account:BondingCurve")).slice(0, 8));
  const v = new DataView(d.buffer);
  [1_000_000_000_000n, 30_000_000_000n, 793_100_000_000_000n, 2_000_000_000n, 1_000_000_000_000_000n].forEach((x, i) => v.setBigUint64(8 + i * 8, x, true));
  d[48] = complete ? 1 : 0;
  return btoa(String.fromCharCode(...d));
}

describe("on-chain market evidence", () => {
  it("derives the live-verified curve address", () => {
    expect(bondingCurveAddress("Bh76tamx2ysaoxwrpYCAFRyUQ6QBGt3pPgpzkmCApump")).toBe("EmqGQAg38iURz6t1mtKbubWLtDwvUrHuCwhfaJhmqUT9");
  });
  it("uses real reserves and refuses unrelated or malformed accounts", () => {
    const c = decodeBondingCurve(curveFixture());
    expect(c).not.toBeNull();
    if (!c) return;
    expect(curvePriceSol(c)).toBeCloseTo(0.00003, 10);
    expect(decodeBondingCurve(btoa("\0".repeat(49)))).toBeNull();
    expect(decodeBondingCurve("not-base64?")).toBeNull();
    expect(() => bondingCurveAddress("invalid")).toThrow();
  });
  it("parses a genuine opposing curve SOL/token movement", () => {
    const t = parseCurveTrade({ blockTime: 100, meta: { err: null, preBalances: [0], postBalances: [1_000_000_000],
      preTokenBalances: [{ mint: "m", owner: "curve", uiTokenAmount: { uiAmount: 100 } }],
      postTokenBalances: [{ mint: "m", owner: "curve", uiTokenAmount: { uiAmount: 80 } }, { mint: "m", owner: "buyer", uiTokenAmount: { uiAmount: 20 } }] },
      transaction: { message: { accountKeys: ["curve"] } } }, "sig", "m", "curve");
    expect(t).toEqual({ signature: "sig", time: 100, wallet: "buyer", side: "buy", sol: 1, tokens: 20 });
  });
  it("excludes future trades and reports verified zero for an empty successful read", () => {
    const a = summarizeActivity([{ signature: "future", blockTime: 110 }], [{ signature: "future", time: 110, wallet: "x", side: "buy", sol: 1, tokens: 1 }], 100, 300);
    expect(a.txCount).toBe(0); expect(a.buys).toBe(0); expect(a.sampleComplete).toBe(true);
  });
  it("blocks missing, stale, invalid and future prices before analysis", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const f = { value: 1, source: "test", at: new Date(now).toISOString() };
    const activity = summarizeActivity([], [], 100, 300);
    expect(marketReadiness({ priceSol: f, priceUsd: f, activity }, now).analyzable).toBe(true);
    for (const p of [{ ...f, value: null }, { ...f, value: Infinity }, { ...f, at: "invalid" }, { ...f, at: new Date(now - 121_000).toISOString() }, { ...f, at: new Date(now + 1000).toISOString() }]) {
      expect(marketReadiness({ priceSol: p, priceUsd: f, activity }, now).analyzable).toBe(false);
    }
    expect(marketReadiness({ priceSol: f, priceUsd: f, activity: null }, now).analyzable).toBe(false);
  });
});