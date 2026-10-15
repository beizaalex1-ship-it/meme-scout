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

function rpcUrls() {
  const custom = process.env["SOLANA_RPC_URL"];
  return [
    ...(custom ? [custom] : []),
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.drpc.org",
  ];
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown;
  for (const url of rpcUrls()) {
    try {
      const res = await getJson<{ result?: T; error?: { message: string } }>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.error) throw new Error(`RPC ${method}: ${res.error.message}`);
      return res.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`RPC ${method} failed on all endpoints`);
}

type ParsedMint = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
};

const PUMP_DEFAULTS = {
  mintAuthority: null,
  freezeAuthority: null,
  supply: 1_000_000_000,
  extensions: [] as string[],
  transferFeeBps: 0,
};

export async function fetchMintInfo(mint: string) {
  try {
    return await fetchMintInfoOnChain(mint);
  } catch (e) {
    if (!mint.endsWith("pump")) throw e;
    console.warn("mint lookup failed, using Pump.fun defaults", mint, e instanceof Error ? e.message : e);
    return { ...PUMP_DEFAULTS, extensions: [...PUMP_DEFAULTS.extensions] };
  }
}

async function fetchMintInfoOnChain(mint: string) {
  const r = await rpc<{ value: { data: { parsed: { info: ParsedMint } } } | null }>("getAccountInfo", [
    mint,
    { encoding: "jsonParsed" },
  ]);
  const info = r.value?.data?.parsed?.info;
  if (!info) throw new Error("Mint account not found");
  const exts = (info.extensions ?? []).map((e) => e.extension);
  const fee = info.extensions?.find((e) => e.extension === "transferFeeConfig")?.state as
    | { newerTransferFee?: { transferFeeBasisPoints?: number } }
    | undefined;
  return {
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    supply: Number(info.supply) / 10 ** info.decimals,
    extensions: exts,
    transferFeeBps: fee?.newerTransferFee?.transferFeeBasisPoints ?? 0,
  };
}

/** Holder % of supply (largest first), excluding the pool / bonding-curve account. Null if unavailable. */
export async function fetchHolderPcts(mint: string, supply: number, poolAddress: string): Promise<number[] | null> {
  try {
    const largest = await rpc<{ value: { address: string; uiAmount: number }[] }>("getTokenLargestAccounts", [mint]);
    const accts = largest.value.slice(0, 20);
    const owners = await rpc<{ value: ({ data: { parsed: { info: { owner: string } } } } | null)[] }>(
      "getMultipleAccounts",
      [accts.map((a) => a.address), { encoding: "jsonParsed" }],
    );
    return accts
      .filter((_, i) => owners.value[i]?.data?.parsed?.info?.owner !== poolAddress)
      .map((a) => (a.uiAmount / supply) * 100);
  } catch (e) {
    console.warn("holder lookup failed", mint, e instanceof Error ? e.message : e);
    return null;
  }
}
