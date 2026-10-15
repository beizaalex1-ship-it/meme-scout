import { rpc, RpcError, type RpcOptions } from "./data.server";
import { analyzeForensics, PUMP_PROGRAM_ID, type FundingObservation, type ForensicsReport, type ParsedTx } from "./forensics";

const SIG_PAGE = 1000;
const MAX_SIG_PAGES = 2;
const EARLY_TXS = 12;
const FUNDING_BUYERS = 4;
const FUNDING_TXS_PER_BUYER = 2;
const CREATOR_HISTORY_TXS = 4;
/** Hard cap on RPC calls per token (rate limits / worker subrequest limits). */
export const FORENSICS_CALL_BUDGET = 32;

// Confirmed transactions never change: cache across tokens and runs (per worker instance).
const txCache = new Map<string, ParsedTx | null>();
const CACHE_MAX = 3000;

type RawTx = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    logMessages?: string[];
    preTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[];
    postTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[];
    innerInstructions?: { instructions: RawIx[] }[];
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: RawIx[] } };
};
type RawIx = { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } };

export function parseTx(raw: RawTx, mint: string): ParsedTx {
  const keys = raw.transaction.message.accountKeys;
  const deltas: Record<string, number> = {};
  for (const b of raw.meta?.preTokenBalances ?? [])
    if (b.mint === mint && b.owner) deltas[b.owner] = (deltas[b.owner] ?? 0) - (b.uiTokenAmount.uiAmount ?? 0);
  for (const b of raw.meta?.postTokenBalances ?? [])
    if (b.mint === mint && b.owner) deltas[b.owner] = (deltas[b.owner] ?? 0) + (b.uiTokenAmount.uiAmount ?? 0);
  const ixs = [...raw.transaction.message.instructions, ...(raw.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const solTransfers = ixs
    .filter((i) => i.program === "system" && (i.parsed?.type === "transfer" || i.parsed?.type === "createAccount"))
    .map((i) => {
      const info = i.parsed!.info ?? {};
      return { from: String(info["source"] ?? ""), to: String(info["destination"] ?? info["newAccount"] ?? ""), lamports: Number(info["lamports"] ?? 0) };
    });
  return {
    signature: raw.transaction.signatures[0] ?? "",
    slot: raw.slot,
    blockTime: raw.blockTime,
    failed: !!raw.meta?.err,
    feePayer: keys[0]?.pubkey ?? "",
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey),
    logs: raw.meta?.logMessages ?? [],
    tokenDeltas: deltas,
    solTransfers,
  };
}

type Sig = { signature: string; slot: number; err: unknown };

class Budget {
  used = 0;
  constructor(private max: number) {}
  take() {
    if (this.used >= this.max) throw new RpcError("rate_limited", "forensics call budget exhausted");
    this.used++;
  }
}

/** rpc() already paces requests and retries 429s with exponential backoff on the Helius endpoint. */
async function call<T>(b: Budget, method: string, params: unknown[], opts?: RpcOptions): Promise<T> {
  b.take();
  return rpc<T>(method, params, opts);
}

async function getTx(b: Budget, sig: string, mint: string, opts?: RpcOptions): Promise<ParsedTx | null> {
  const key = `${mint}:${sig}`;
  if (txCache.has(key)) return txCache.get(key)!;
  const raw = await call<RawTx | null>(b, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], opts);
  const parsed = raw ? parseTx(raw, mint) : null;
  if (raw) {
    if (txCache.size >= CACHE_MAX) txCache.delete(txCache.keys().next().value!);
    txCache.set(key, parsed);
  }
  return parsed;
}

/** Fetch a small, budgeted window of on-chain history and analyse it. Never throws. */
export async function investigateWallets(
  mint: string,
  supply: number,
  excludeOwners: string[],
  opts?: RpcOptions,
): Promise<ForensicsReport> {
  const b = new Budget(FORENSICS_CALL_BUDGET);
  const notes: string[] = [];
  let createTx: ParsedTx | null = null;
  let historyComplete = false;
  let earlyTxs: ParsedTx[] | null = null;
  const fundings: FundingObservation[] = [];
  const fundingFailed: string[] = [];
  let creatorHistory: { txsChecked: number; priorLaunches: number; moreHistory: boolean } | null = null;

  try {
    // 1. Full mint signature history (newest first) to reach the creation tx.
    const sigs: Sig[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_SIG_PAGES; page++) {
      const batch = await call<Sig[]>(b, "getSignaturesForAddress", [mint, { limit: SIG_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }], opts);
      sigs.push(...batch);
      if (batch.length < SIG_PAGE) {
        historyComplete = true;
        break;
      }
      before = batch.at(-1)!.signature;
    }
    if (!historyComplete) notes.push(`Mint has more than ${SIG_PAGE * MAX_SIG_PAGES} transactions; launch window not reachable`);
    const asc = sigs.reverse();

    if (historyComplete && asc.length) {
      createTx = await getTx(b, asc[0]!.signature, mint, opts);
      // 2. Earliest trades after creation.
      const early = asc.slice(1, 1 + EARLY_TXS).filter((s) => !s.err);
      const got: ParsedTx[] = [];
      for (let i = 0; i < early.length; i += 4) {
        const res = await Promise.all(early.slice(i, i + 4).map((s) => getTx(b, s.signature, mint, opts)));
        got.push(...res.filter((t): t is ParsedTx => !!t));
      }
      earlyTxs = got;
      if (asc.length - 1 > EARLY_TXS) notes.push(`Only the first ${EARLY_TXS} of ${asc.length - 1} trades analysed`);
    }
  } catch (e) {
    notes.push(`Transaction history lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const creatorWallet = createTx && historyComplete ? createTx.feePayer : null;

  // 3. Funding of the largest early buyers: inbound SOL transfer shortly before their first buy.
  if (earlyTxs) {
    const firstBuy = new Map<string, ParsedTx>();
    for (const tx of earlyTxs)
      for (const [owner, d] of Object.entries(tx.tokenDeltas))
        if (d > 0 && owner === tx.feePayer && owner !== creatorWallet && !firstBuy.has(owner)) firstBuy.set(owner, tx);
    const top = [...firstBuy.entries()]
      .sort((a, b2) => (b2[1].tokenDeltas[b2[0]] ?? 0) - (a[1].tokenDeltas[a[0]] ?? 0))
      .slice(0, FUNDING_BUYERS);
    for (const [wallet, buyTx] of top) {
      try {
        const prior = await call<Sig[]>(b, "getSignaturesForAddress", [wallet, { limit: FUNDING_TXS_PER_BUYER, before: buyTx.signature, commitment: "confirmed" }], opts);
        let found: FundingObservation | null = null;
        for (const s of prior) {
          const t = await getTx(b, s.signature, mint, opts);
          const inbound = t?.solTransfers.filter((x) => x.to === wallet && x.from !== wallet).sort((x, y) => y.lamports - x.lamports)[0];
          if (t && inbound) {
            found = { wallet, funder: inbound.from, signature: t.signature, slot: t.slot, lamports: inbound.lamports };
            break;
          }
        }
        fundings.push(found ?? { wallet, funder: null, signature: null, slot: null, lamports: null });
      } catch {
        fundingFailed.push(wallet);
      }
    }
  }

  // 4. Creator's recent activity: other Pump.fun creates.
  if (creatorWallet) {
    try {
      const recent = await call<Sig[]>(b, "getSignaturesForAddress", [creatorWallet, { limit: CREATOR_HISTORY_TXS + 1, commitment: "confirmed" }], opts);
      const others = recent.filter((s) => s.signature !== createTx!.signature).slice(0, CREATOR_HISTORY_TXS);
      let priorLaunches = 0;
      for (const s of others) {
        const t = await getTx(b, s.signature, "-", opts);
        if (t && t.feePayer === creatorWallet && t.logs.some((l) => l.startsWith(`Program ${PUMP_PROGRAM_ID} invoke`)) && t.logs.some((l) => /Instruction: Create(V2)?$/.test(l)))
          priorLaunches++;
      }
      creatorHistory = { txsChecked: others.length, priorLaunches, moreHistory: recent.length > CREATOR_HISTORY_TXS };
    } catch {
      creatorHistory = null;
    }
  }

  const report = analyzeForensics({
    mint,
    supply,
    createTx,
    historyComplete,
    earlyTxs,
    excludeOwners,
    fundings,
    fundingFailed,
    creatorHistory,
    notes,
  });
  report.limitations.push(`Funding checked only in each buyer's last ${FUNDING_TXS_PER_BUYER} transactions before buying; ${b.used}/${FORENSICS_CALL_BUDGET} RPC calls used`);
  console.log(JSON.stringify({ evt: "forensics", mint, status: report.status, creator: report.creator.status, calls: b.used }));
  return report;
}
