import { describe, expect, it } from "vitest";
import { fetchHolderPcts, fetchMintInfo, rpc } from "./data.server";

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
const mintAccount = (info: Record<string, unknown>) => ({ value: { data: { parsed: { info } } } });
const goodMint = { mintAuthority: null, freezeAuthority: null, supply: "1000000000000000", decimals: 6 };

describe("Solana RPC", () => {
  it("returns mint info on RPC success", async () => {
    const res = await fetchMintInfo("Mpump", { urls: ["https://a"], fetchImpl: async () => ok(mintAccount(goodMint)) });
    expect(res).toEqual({
      ok: true,
      info: { mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, extensions: [], transferFeeBps: 0 },
    });
  });

  it("falls back to the next endpoint after a 403", async () => {
    let calls = 0;
    const res = await fetchMintInfo("Mpump", {
      urls: ["https://blocked", "https://good"],
      fetchImpl: async () => (++calls === 1 ? new Response("blocked", { status: 403 }) : ok(mintAccount(goodMint))),
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("reports failure (no assumed defaults) when every endpoint is blocked", async () => {
    const res = await fetchMintInfo("Xpump", { urls: ["https://a"], fetchImpl: async () => new Response("", { status: 403 }) });
    expect(res.ok).toBe(false);
  });

  it("times out slow endpoints", async () => {
    const slow: typeof fetch = (_u, init) =>
      new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    await expect(rpc("getHealth", [], { urls: ["https://slow"], fetchImpl: slow, timeoutMs: 20 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("classifies 429 as rate limited", async () => {
    await expect(
      rpc("getHealth", [], { urls: ["https://a"], fetchImpl: async () => new Response("", { status: 429 }) }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("reports missing mint account as failure", async () => {
    const res = await fetchMintInfo("Mpump", { urls: ["https://a"], fetchImpl: async () => ok({ value: null }) });
    expect(res).toMatchObject({ ok: false });
  });

  it("returns unavailable holder data when RPC fails", async () => {
    const res = await fetchHolderPcts("M", 1e9, "POOL", { urls: ["https://a"], fetchImpl: async () => new Response("", { status: 403 }) });
    expect(res.ok).toBe(false);
  });

  it("computes holder % from real RPC data, excluding the pool", async () => {
    let n = 0;
    const res = await fetchHolderPcts("M", 1_000_000_000, "POOL", {
      urls: ["https://a"],
      fetchImpl: async () =>
        ++n === 1
          ? ok({ value: [{ address: "p", uiAmount: 900_000_000 }, { address: "w", uiAmount: 40_000_000 }] })
          : ok({ value: [{ data: { parsed: { info: { owner: "POOL" } } } }, { data: { parsed: { info: { owner: "W" } } } }] }),
    });
    expect(res).toEqual({ ok: true, holders: { pcts: [4], excluded: 1 } });
  });
});
