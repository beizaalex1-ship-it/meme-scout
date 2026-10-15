// Prediction & outcome engine (pure, testable). Predictions are frozen at detection time;
// later observations are separate rows and never feed back into the original prediction.

export const CHECKPOINTS = [
  { key: "5m", minutes: 5 },
  { key: "15m", minutes: 15 },
  { key: "30m", minutes: 30 },
  { key: "60m", minutes: 60 },
  { key: "24h", minutes: 1440 },
] as const;
export type CheckpointKey = (typeof CHECKPOINTS)[number]["key"];

/** An observation taken later than this after its due time is marked unavailable (stale). */
export const MAX_LATE_MIN: Record<CheckpointKey, number> = { "5m": 10, "15m": 10, "30m": 15, "60m": 20, "24h": 120 };

export type MarketPoint = {
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
};

type PairLike = {
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  volume?: Record<string, number>;
};

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function marketPointFromPair(p: PairLike): MarketPoint {
  return {
    priceUsd: num(p.priceUsd),
    liquidityUsd: num(p.liquidity?.usd),
    marketCapUsd: num(p.marketCap ?? p.fdv),
    volumeH1Usd: num(p.volume?.["h1"]),
    volumeH24Usd: num(p.volume?.["h24"]),
  };
}

/** Percent change; null when either price is missing or the base is not positive. */
export function priceChangePct(initial: number | null, later: number | null): number | null {
  if (initial === null || later === null || !(initial > 0)) return null;
  return Math.round(((later - initial) / initial) * 10000) / 100;
}

/** One discovery event per mint (scanned_tokens dedupes mints), so the key is the mint. */
export function discoveryKey(mint: string) {
  return `${mint}:first`;
}

export function scheduleObservations(detectedAt: Date) {
  return CHECKPOINTS.map((c) => ({
    checkpoint: c.key,
    due_at: new Date(detectedAt.getTime() + c.minutes * 60_000).toISOString(),
    status: "pending" as const,
  }));
}

export type ObservationResult =
  | { status: "recorded"; observed_at: string; price_usd: number | null; liquidity_usd: number | null; market_cap_usd: number | null; volume_h1_usd: number | null; volume_h24_usd: number | null; price_change_pct: number | null; reason: string | null }
  | { status: "unavailable"; observed_at: string; reason: string }
  | { status: "retry"; reason: string };

/**
 * Turns a fetch result into an observation. point = null means the token was not listed;
 * fetchError = the data source failed. Never fills in values that were not returned.
 */
export function buildObservation(args: {
  checkpoint: CheckpointKey;
  dueAt: Date;
  now: Date;
  initialPrice: number | null;
  point: MarketPoint | null;
  fetchError?: string | undefined;
}): ObservationResult {
  const observed_at = args.now.toISOString();
  const lateMin = (args.now.getTime() - args.dueAt.getTime()) / 60_000;
  if (lateMin > MAX_LATE_MIN[args.checkpoint])
    return { status: "unavailable", observed_at, reason: `Missed window: checked ${Math.round(lateMin)} min after due time` };
  // Temporary source failure: stay pending and retry next scan; the window check above
  // turns it into "unavailable" if it never succeeds in time.
  if (args.fetchError) return { status: "retry", reason: `Data source failed: ${args.fetchError.slice(0, 200)}` };
  if (!args.point) return { status: "unavailable", observed_at, reason: "Token no longer listed on DexScreener" };
  const p = args.point;
  return {
    status: "recorded",
    observed_at,
    price_usd: p.priceUsd,
    liquidity_usd: p.liquidityUsd,
    market_cap_usd: p.marketCapUsd,
    volume_h1_usd: p.volumeH1Usd,
    volume_h24_usd: p.volumeH24Usd,
    price_change_pct: priceChangePct(args.initialPrice, p.priceUsd),
    reason: p.priceUsd === null ? "Listed but no price returned" : null,
  };
}

/** Deep-freezes a plain-JSON copy so later mutations of the source cannot leak in. */
export function freezeSnapshot<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const deep = (o: unknown) => {
    if (o && typeof o === "object") {
      Object.values(o).forEach(deep);
      Object.freeze(o);
    }
  };
  deep(copy);
  return copy;
}

export type PredictionInput = {
  mint: string;
  name: string | null;
  symbol: string | null;
  detectedAt: Date;
  pairCreatedAt: number | null;
  status: "rejected" | "passed" | "alerted";
  verdict: string | null;
  score: number | null;
  securityVerdict: string | null;
  walletRisk: string | null;
  market: MarketPoint & { txns?: Record<string, { buys: number; sells: number }> };
  reports: Record<string, unknown>;
  missing: string[];
};

export function buildPrediction(i: PredictionInput) {
  const snapshot = freezeSnapshot({
    detectedAt: i.detectedAt.toISOString(),
    tokenAgeMin: i.pairCreatedAt ? Math.round((i.detectedAt.getTime() - i.pairCreatedAt) / 60_000) : null,
    market: i.market,
    reports: i.reports,
    missing: i.missing,
  });
  return {
    mint: i.mint,
    discovery_key: discoveryKey(i.mint),
    detected_at: i.detectedAt.toISOString(),
    pair_created_at: i.pairCreatedAt ? new Date(i.pairCreatedAt).toISOString() : null,
    name: i.name,
    symbol: i.symbol,
    status: i.status,
    verdict: i.verdict,
    score: i.score,
    security_verdict: i.securityVerdict,
    wallet_risk: i.walletRisk,
    initial_price_usd: i.market.priceUsd,
    initial_liquidity_usd: i.market.liquidityUsd,
    initial_market_cap_usd: i.market.marketCapUsd,
    snapshot,
  };
}
