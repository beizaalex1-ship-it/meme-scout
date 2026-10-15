import { computeHolderPcts } from "./rules";
// Free data sources: DexScreener (discovery + market + socials) and Solana RPC (contract + holders).

export type DexPair = {
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
  info?: { websites?: { url: string; label?: string }[]; socials?: { url: string; type: string }[] };
};

export type TokenProfile = { tokenAddress: string; chainId: string; description?: string };

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Brand-new Pump.fun launches (GeckoTerminal new pools), newest first, within maxAgeMin. */
export async function discoverPumpMints(maxAgeMin = 10): Promise<{ mint: string; description: string | undefined }[]> {
  type Pool = { attributes: { pool_created_at: string }; relationships: { dex: { data: { id: string } }; base_token: { data: { id: string } } } };
  const pages = await Promise.allSettled(
    [1, 2, 3].map((p) => getJson<{ data: Pool[] }>(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${p}`)),
  );
  const cutoff = Date.now() - maxAgeMin * 60_000;
  const seen = new Set<string>();
  for (const pg of pages) {
    if (pg.status !== "fulfilled") continue;
    for (const pool of pg.value.data ?? []) {
      const mint = pool.relationships.base_token.data.id.replace(/^solana_/, "");
      if (!pool.relationships.dex.data.id.startsWith("pump") || !mint.endsWith("pump")) continue;
      if (Date.parse(pool.attributes.pool_created_at) < cutoff) continue;
      seen.add(mint);
    }
  }
  return [...seen].map((mint) => ({ mint, description: undefined }));
}

/** Best (highest-liquidity / pump) pair per mint. */
export async function fetchPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`);
    for (const p of pairs) {
      const mint = p.baseToken.address;
      const prev = out.get(mint);
      if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(mint, p);
    }
  }
  return out;
}

export function rpcUrls() {
  const custom = process.env["SOLANA_RPC_URL"];
  return [
    ...(custom ? [custom] : []),
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.drpc.org",
  ];
}

export class RpcError extends Error {
  constructor(
    public kind: "timeout" | "blocked" | "rate_limited" | "http" | "rpc" | "network",
    message: string,
  ) {
    super(message);
  }
}

/** Host only — never log the full URL (custom RPC URLs embed API keys). */
function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export type RpcOptions = { urls?: string[]; fetchImpl?: typeof fetch; timeoutMs?: number };

export async function rpc<T>(method: string, params: unknown[], opts: RpcOptions = {}): Promise<T> {
  const urls = opts.urls ?? rpcUrls();
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const errors: RpcError[] = [];
  for (const url of urls) {
    const host = safeHost(url);
    const started = Date.now();
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const kind = res.status === 429 ? "rate_limited" : res.status === 403 || res.status === 401 ? "blocked" : "http";
        throw new RpcError(kind, `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { result?: T; error?: { code?: number; message: string } };
      if (body.error) throw new RpcError(body.error.code === 429 ? "rate_limited" : "rpc", body.error.message.slice(0, 160));
      return body.result as T;
    } catch (e) {
      const err =
        e instanceof RpcError
          ? e
          : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
            ? new RpcError("timeout", `timed out after ${timeoutMs}ms`)
            : new RpcError("network", e instanceof Error ? e.message.slice(0, 160) : String(e));
      errors.push(err);
      console.warn(JSON.stringify({ evt: "rpc_fail", method, host, kind: err.kind, msg: err.message, ms: Date.now() - started }));
    }
  }
  const last = errors.at(-1);
  throw new RpcError(last?.kind ?? "network", `${method} failed on ${urls.length} endpoint(s): ${errors.map((x) => x.kind).join(", ") || "no endpoints"}`);
}

type ParsedMint = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
};

export type MintInfo = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: number;
  extensions: string[];
  transferFeeBps: number;
};

/** Real on-chain mint data, or an explicit failure. Never substitutes assumed values. */
export async function fetchMintInfo(
  mint: string,
  opts?: RpcOptions,
): Promise<{ ok: true; info: MintInfo } | { ok: false; reason: string }> {
  try {
    const r = await rpc<{ value: { data: { parsed?: { info?: ParsedMint } } } | null }>(
      "getAccountInfo",
      [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
      opts,
    );
    const info = r?.value?.data?.parsed?.info;
    if (!info || typeof info.decimals !== "number" || info.supply === undefined)
      return { ok: false, reason: "mint account not found or not a parsed SPL mint" };
    const fee = info.extensions?.find((e) => e.extension === "transferFeeConfig")?.state as
      | { newerTransferFee?: { transferFeeBasisPoints?: number } }
      | undefined;
    return {
      ok: true,
      info: {
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        supply: Number(info.supply) / 10 ** info.decimals,
        extensions: (info.extensions ?? []).map((e) => e.extension),
        transferFeeBps: fee?.newerTransferFee?.transferFeeBasisPoints ?? 0,
      },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Largest token accounts with resolved owners, pool/bonding curve excluded. Null when the lookup fails. */
export async function fetchHolderPcts(
  mint: string,
  supply: number,
  poolAddress: string,
  opts?: RpcOptions,
): Promise<{ ok: true; holders: { pcts: number[]; excluded: number } } | { ok: false; reason: string }> {
  try {
    const largest = await rpc<{ value: { address: string; uiAmount: number | null }[] }>(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }],
      opts,
    );
    const accts = (largest?.value ?? []).slice(0, 20);
    if (!accts.length) return { ok: false, reason: "no token accounts returned" };
    const owners = await rpc<{ value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] }>(
      "getMultipleAccounts",
      [accts.map((a) => a.address), { encoding: "jsonParsed" }],
      opts,
    );
    const holders = computeHolderPcts(
      accts.map((a, i) => ({
        address: a.address,
        uiAmount: a.uiAmount ?? 0,
        owner: owners?.value?.[i]?.data?.parsed?.info?.owner ?? null,
      })),
      supply,
      [poolAddress, ...KNOWN_PROGRAM_OWNERS],
    );
    if (!holders) return { ok: false, reason: "could not resolve all holder owners" };
    return { ok: true, holders };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Program-owned accounts that hold liquidity, not insider supply. */
const KNOWN_PROGRAM_OWNERS = [
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg", // Pump.fun migration / fee account
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
];
