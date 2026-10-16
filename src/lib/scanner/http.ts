// Polite HTTP client for free market-data APIs (DexScreener, GeckoTerminal).
// Bounded retries with exponential backoff + jitter, Retry-After support, per-host pacing,
// a per-host cooldown after repeated 429s (so one scan never hammers a limiting provider),
// and a short response cache so the same URL is not requested twice in quick succession.

export type HttpOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  retries?: number;
  cacheTtlMs?: number;
  timeoutMs?: number;
};

export const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  "api.geckoterminal.com": 2100, // free tier ~30 calls/min
  "api.dexscreener.com": 250, // ~300/min on token endpoints
};
const COOLDOWN_MS = 60_000;
const MAX_BACKOFF_MS = 8_000;

type State = { nextAt: Map<string, number>; cooldownUntil: Map<string, number>; cache: Map<string, { at: number; body: unknown }> };
const state: State = { nextAt: new Map(), cooldownUntil: new Map(), cache: new Map() };
export function resetHttpState() {
  state.nextAt.clear();
  state.cooldownUntil.clear();
  state.cache.clear();
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public temporary: boolean,
  ) {
    super(message);
  }
}

const isTemporary = (s: number) => s === 429 || s === 408 || s >= 500;

export function backoffMs(attempt: number, retryAfterHeader: string | null, random: () => number) {
  const ra = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(MAX_BACKOFF_MS, ra * 1000);
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(base / 2 + random() * (base / 2)); // "equal jitter"
}

export async function getJsonPolite<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const retries = opts.retries ?? 2;
  const ttl = opts.cacheTtlMs ?? 30_000;
  const host = new URL(url).host;

  const cached = state.cache.get(url);
  if (cached && now() - cached.at < ttl) return cached.body as T;

  const cool = state.cooldownUntil.get(host) ?? 0;
  if (now() < cool) throw new HttpError(429, `${host} cooling down after rate limits (${Math.ceil((cool - now()) / 1000)}s left)`, true);

  let lastErr: HttpError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (state.nextAt.get(host) ?? 0) - now();
    if (wait > 0) await sleep(wait);
    state.nextAt.set(host, now() + (HOST_MIN_INTERVAL_MS[host] ?? 200));
    let res: Response;
    try {
      res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    } catch (e) {
      lastErr = new HttpError(0, `${host} network error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), true);
      if (attempt < retries) await sleep(backoffMs(attempt, null, random));
      continue;
    }
    if (res.ok) {
      const body = (await res.json()) as T;
      state.cache.set(url, { at: now(), body });
      return body;
    }
    const text = (await res.text()).slice(0, 120);
    lastErr = new HttpError(res.status, `${host} failed [${res.status}]: ${text}`, isTemporary(res.status));
    if (!lastErr.temporary) throw lastErr;
    if (attempt < retries) await sleep(backoffMs(attempt, res.headers.get("retry-after"), random));
  }
  if (lastErr?.status === 429) state.cooldownUntil.set(host, now() + COOLDOWN_MS);
  throw lastErr ?? new HttpError(0, `${host} failed`, true);
}
