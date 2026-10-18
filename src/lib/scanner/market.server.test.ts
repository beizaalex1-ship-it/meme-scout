import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), http: vi.fn() }));
vi.mock("./data.server", () => ({ rpc: mocks.rpc }));
vi.mock("./http", () => ({ getJsonPolite: mocks.http }));
import { attachActivity, buildMarketData, fetchActivity, fetchOnchainBatch, fetchSolUsd, fetchOutcomePrices, toPairLike } from "./market.server";
import { marketReadiness } from "./onchain";
import { PUMP_PROGRAM_ID } from "./forensics";
const mint = "Bh76tamx2ysaoxwrpYCAFRyUQ6QBGt3pPgpzkmCApump";
function curve() {
  const d = new Uint8Array(49); d.set(sha256(new TextEncoder().encode("account:BondingCurve")).slice(0, 8));
  const v = new DataView(d.buffer);
  [1_000_000_000_000n, 30_000_000_000n, 793_100_000_000_000n, 2_000_000_000n, 1_000_000_000_000_000n].forEach((x, i) => v.setBigUint64(8 + i * 8, x, true));
  return btoa(String.fromCharCode(...d));
}
const acct = { owner: PUMP_PROGRAM_ID, data: [curve(), "base64"] };
beforeEach(() => { mocks.rpc.mockReset(); mocks.http.mockReset(); });
describe("live market fetching and fallback", () => {
  it("analyzes on-chain data even when the indexed coin is absent", async () => {
    mocks.rpc.mockResolvedValueOnce({ context: { slot: 123 }, value: [
      { owner: "token", data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: "1000000000000000", decimals: 6 } } } }, acct, null,
    ] }).mockResolvedValueOnce([]);
    const oc = (await fetchOnchainBatch([mint])).get(mint);
    const md = buildMarketData(oc, undefined, null, { value: 100, source: "reference", at: new Date().toISOString() }, 1_000_000_000);
    await attachActivity(mint, oc, undefined, null, md);
    expect(md.priceUsd.value).toBeCloseTo(0.003);
    expect(md.activity?.buys).toBe(0);
    expect(marketReadiness(md, Date.now()).analyzable).toBe(true);
    expect(toPairLike(mint, oc, undefined, md).volume?.["h1"]).toBeUndefined();
  });
  it("failed account and activity reads remain missing, never verified zero or PASS", async () => {
    mocks.rpc.mockRejectedValue(new Error("budget reached"));
    const oc = (await fetchOnchainBatch([mint])).get(mint);
    expect(oc?.mintRes.ok).toBe(false);
    const md = buildMarketData(oc, undefined, null, { value: null, source: "none", at: null }, null);
    await attachActivity(mint, oc, undefined, null, md);
    expect(md.activity).toBeNull();
    expect(marketReadiness(md, Date.now()).analyzable).toBe(false);
  });
  it("refuses wrong-owner curve accounts", async () => {
    mocks.rpc.mockResolvedValue({ context: { slot: 1 }, value: [null, { ...acct, owner: "wrong" }, null] });
    expect((await fetchOnchainBatch([mint])).get(mint)?.curve).toBeNull();
  });
  it("marks a busy sampled trade window incomplete and rejects null transaction reads", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sigs = Array.from({ length: 20 }, (_, i) => ({ signature: String(i), blockTime: now - i }));
    mocks.rpc.mockImplementation(async (method: string) => method === "getSignaturesForAddress" ? sigs : { blockTime: now, meta: { err: null } });
    expect((await fetchActivity(mint, "curve", now)).summary.sampleComplete).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(13);
    mocks.rpc.mockImplementation(async (method: string) => method === "getSignaturesForAddress" ? sigs : null);
    await expect(fetchActivity(mint, "curve", now)).rejects.toThrow("unavailable");
  });
  it("uses reference fallback and does not relabel stale indexed prices as fresh", async () => {
    mocks.http.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ result: { SOLUSD: { c: ["100"] } } });
    const sol = await fetchSolUsd(); expect(sol.source).toContain("kraken");
    const dex = { dexId: "pumpfun", pairAddress: "curve", baseToken: { address: mint, name: "x", symbol: "x" }, priceUsd: "0.1", txns: { m5: { buys: 5, sells: 1 } } };
    const md = buildMarketData(undefined, dex, new Date(Date.now() - 121_000).toISOString(), sol, null);
    await attachActivity(mint, undefined, dex, md.priceUsd.at, md);
    expect(md.activity?.sampleComplete).toBe(false);
    expect(marketReadiness(md, Date.now()).analyzable).toBe(false);
  });
  it("batches real follow-up prices without inventing hourly volume", async () => {
    mocks.http.mockResolvedValue({ So11111111111111111111111111111111111111112: { usdPrice: 100 } });
    mocks.rpc.mockResolvedValue({ value: [acct] });
    const r = (await fetchOutcomePrices([mint])).get(mint);
    expect(r?.point?.priceUsd).toBeCloseTo(0.003);
    expect(r?.point?.volumeH1Usd).toBeNull();
    expect(r?.reason).toContain("observed now");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});