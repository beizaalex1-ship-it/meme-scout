import { beforeEach, describe, expect, it } from "vitest";
import { backoffMs, getJsonPolite, HttpError, resetHttpState } from "./http";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, sleep: async () => {}, random: () => 0.5 });

describe("polite market-data client", () => {
  beforeEach(resetHttpState);

  it("retries a temporary 429 and then succeeds", async () => {
    let n = 0;
    const r = await getJsonPolite<{ a: number }>("https://api.dexscreener.com/x", opts(async () => (++n < 2 ? new Response("", { status: 429 }) : json({ a: 1 }))));
    expect(r.a).toBe(1);
    expect(n).toBe(2);
  });

  it("retries are bounded (3 attempts max) and then the host cools down without new requests", async () => {
    let n = 0;
    const f = (async () => (n++, new Response("", { status: 429 }))) as typeof fetch;
    await expect(getJsonPolite("https://api.dexscreener.com/a", opts(f))).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(3);
    await expect(getJsonPolite("https://api.dexscreener.com/b", opts(f))).rejects.toThrow(/cooling down/);
    expect(n).toBe(3);
  });

  it("does not retry permanent errors", async () => {
    let n = 0;
    await expect(getJsonPolite("https://api.dexscreener.com/c", opts(async () => (n++, new Response("", { status: 404 }))))).rejects.toMatchObject({ status: 404, temporary: false });
    expect(n).toBe(1);
  });

  it("serves a repeated request from cache", async () => {
    let n = 0;
    const f = (async () => (n++, json({ ok: 1 }))) as typeof fetch;
    await getJsonPolite("https://api.dexscreener.com/d", opts(f));
    await getJsonPolite("https://api.dexscreener.com/d", opts(f));
    expect(n).toBe(1);
  });

  it("backoff grows, has jitter, and honours Retry-After", () => {
    expect(backoffMs(0, null, () => 0)).toBe(500);
    expect(backoffMs(2, null, () => 1)).toBe(4000);
    expect(backoffMs(0, "3", () => 0)).toBe(3000);
  });
});
