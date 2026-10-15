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
    await expect(rpc("getHealth", [], { urls: ["https://slow"], fetchImpl: slow, timeoutMs: 20, retries: 0 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("classifies 429 as rate limited", async () => {
    await expect(
      rpc("getHealth", [], { urls: ["https://a"], retries: 0, fetchImpl: async () => new Response("", { status: 429 }) }),
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

describe("Helius-only RPC with backoff", () => {
  it("retries 429 with backoff on the same endpoint and then succeeds", async () => {
    let calls = 0;
    const res = await rpc<number>("getSlot", [], {
      urls: ["https://helius"],
      baseDelayMs: 1,
      fetchImpl: async () => (++calls < 3 ? new Response("", { status: 429 }) : ok(42)),
    });
    expect(res).toBe(42);
    expect(calls).toBe(3);
  });

  it("gives up after the retry limit and reports rate_limited", async () => {
    let calls = 0;
    await expect(
      rpc("getSlot", [], { urls: ["https://helius"], retries: 2, baseDelayMs: 1, fetchImpl: async () => (++calls, new Response("", { status: 429 })) }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toBe(3);
  });

  it("does not retry a blocked (403) endpoint", async () => {
    let calls = 0;
    await expect(
      rpc("getSlot", [], { urls: ["https://helius"], baseDelayMs: 1, fetchImpl: async () => (++calls, new Response("", { status: 403 })) }),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(calls).toBe(1);
  });

  it("uses only SOLANA_RPC_URL — no public fallbacks", async () => {
    const { rpcUrls } = await import("./data.server");
    const prev = process.env["SOLANA_RPC_URL"];
    process.env["SOLANA_RPC_URL"] = "https://helius.example";
    expect(rpcUrls()).toEqual(["https://helius.example"]);
    delete process.env["SOLANA_RPC_URL"];
    expect(rpcUrls()).toEqual([]);
    await expect(rpc("getSlot", [])).rejects.toMatchObject({ kind: "blocked" });
    if (prev) process.env["SOLANA_RPC_URL"] = prev;
  });
});
