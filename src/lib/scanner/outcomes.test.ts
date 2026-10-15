import { describe, expect, it } from "vitest";
import { buildObservation, buildPrediction, discoveryKey, priceChangePct, scheduleObservations, type PredictionInput } from "./outcomes";

const detectedAt = new Date("2026-10-15T20:00:00Z");
const input = (): PredictionInput => ({
  mint: "Mpump", name: "T", symbol: "T", detectedAt, pairCreatedAt: detectedAt.getTime() - 4 * 60_000, status: "alerted",
  verdict: "v", score: 35, securityVerdict: "PASS", walletRisk: "Moderate",
  market: { priceUsd: 0.0001, liquidityUsd: 9000, marketCapUsd: 10000, volumeH1Usd: 500, volumeH24Usd: 500 },
  reports: { security: { verdict: "PASS" } }, missing: [],
});

describe("predictions", () => {
  it("snapshot cannot be changed by later mutation of the source data", () => {
    const i = input();
    const p = buildPrediction(i);
    (i.market as { priceUsd: number }).priceUsd = 999;
    (i.reports["security"] as { verdict: string }).verdict = "FAIL";
    expect(p.initial_price_usd).toBe(0.0001);
    expect((p.snapshot.reports["security"] as { verdict: string }).verdict).toBe("PASS");
    expect(Object.isFrozen(p.snapshot.market)).toBe(true);
  });
  it("records token age at detection and contains no outcome fields", () => {
    const p = buildPrediction(input());
    expect(p.snapshot.tokenAgeMin).toBe(4);
    expect(JSON.stringify(p)).not.toMatch(/observ|price_change/);
  });
  it("same mint always yields the same discovery key (duplicates ignored on insert)", () => {
    expect(buildPrediction(input()).discovery_key).toBe(discoveryKey("Mpump"));
  });
  it("schedules 5m, 15m, 30m, 60m and 24h checks", () => {
    const s = scheduleObservations(detectedAt);
    expect(s.map((o) => o.checkpoint)).toEqual(["5m", "15m", "30m", "60m", "24h"]);
    expect(s[4]!.due_at).toBe("2026-10-16T20:00:00.000Z");
  });
});

describe("price change", () => {
  it("calculates percent change", () => {
    expect(priceChangePct(0.0001, 0.00015)).toBe(50);
    expect(priceChangePct(2, 1)).toBe(-50);
  });
  it("is null when a price is missing or zero", () => {
    expect(priceChangePct(null, 1)).toBeNull();
    expect(priceChangePct(0, 1)).toBeNull();
    expect(priceChangePct(1, null)).toBeNull();
  });
});

describe("observations", () => {
  const due = new Date(detectedAt.getTime() + 5 * 60_000);
  const now = new Date(due.getTime() + 60_000);
  const point = { priceUsd: 0.0002, liquidityUsd: 1, marketCapUsd: 2, volumeH1Usd: 3, volumeH24Usd: 4 };
  it("records measured values and change from the original price", () => {
    const o = buildObservation({ checkpoint: "5m", dueAt: due, now, initialPrice: 0.0001, point });
    expect(o).toMatchObject({ status: "recorded", price_usd: 0.0002, price_change_pct: 100 });
  });
  it("delisted token is unavailable, never simulated", () => {
    const o = buildObservation({ checkpoint: "5m", dueAt: due, now, initialPrice: 0.0001, point: null });
    expect(o.status).toBe("unavailable");
    expect(o).not.toHaveProperty("price_usd");
  });
  it("temporary data-source failure stays pending for retry, never recorded", () => {
    const o = buildObservation({ checkpoint: "5m", dueAt: due, now, initialPrice: 0.0001, point, fetchError: "429" });
    expect(o).toMatchObject({ status: "retry", reason: "Data source failed: 429" });
  });
  it("failure past the window becomes unavailable", () => {
    const late = new Date(due.getTime() + 11 * 60_000);
    expect(buildObservation({ checkpoint: "5m", dueAt: due, now: late, initialPrice: 0.0001, point, fetchError: "429" }).status).toBe("unavailable");
  });
  it("a check far past its window is not recorded as that checkpoint", () => {
    const late = new Date(due.getTime() + 30 * 60_000);
    expect(buildObservation({ checkpoint: "5m", dueAt: due, now: late, initialPrice: 0.0001, point }).status).toBe("unavailable");
  });
});
