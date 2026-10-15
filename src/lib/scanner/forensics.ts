// Wallet Investigator forensics: pure analysis of already-fetched Solana transactions.
// Verified facts (observed on-chain) are kept separate from suspected patterns (inferences).

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const SNIPER_MAX_SLOT_OFFSET = 2; // bought within 2 slots (~1s) of the create transaction
export const SNIPER_MIN_PCT = 2; // and acquired at least 2% of supply
export const CREATOR_LINKED_RED_FLAG_PCT = 30;

/** Minimal, normalized view of one parsed Solana transaction. */
export type ParsedTx = {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  feePayer: string;
  signers: string[];
  logs: string[];
  /** owner -> change in this mint's token balance (UI units) */
  tokenDeltas: Record<string, number>;
  solTransfers: { from: string; to: string; lamports: number }[];
};

export type FundingObservation = {
  wallet: string;
  /** null = wallet's pre-buy history was checked and no inbound SOL transfer was found */
  funder: string | null;
  signature: string | null;
  slot: number | null;
  lamports: number | null;
};

export type ForensicsInput = {
  mint: string;
  supply: number;
  /** Oldest transaction for the mint; null when not fetched. */
  createTx: ParsedTx | null;
  /** true only when the full mint signature history was paged to its start. */
  historyComplete: boolean;
  /** Earliest transactions after creation (ascending). null = could not be fetched. */
  earlyTxs: ParsedTx[] | null;
  excludeOwners: string[];
  fundings: FundingObservation[];
  /** wallets whose funding lookup failed */
  fundingFailed: string[];
  creatorHistory: { txsChecked: number; priorLaunches: number; moreHistory: boolean } | null;
  notes: string[];
};

export type Evidence = "VERIFIED" | "UNVERIFIED";

export type ForensicsReport = {
  status: "COMPLETE" | "PARTIAL" | "UNVERIFIED";
  creator: { wallet: string | null; status: Evidence; source: string; evidence: string };
  creatorHistory: {
    status: Evidence;
    priorLaunchesSeen: number | null;
    txsChecked: number;
    soldThisTokenInWindow: boolean | null;
    note: string;
  };
  creatorBuyPct: number | null;
  earlyBuyers: { wallet: string; pct: number; slotOffset: number; signature: string }[];
  snipers: { wallet: string; pct: number; slotOffset: number }[];
  fundingClusters: { funder: string; wallets: string[]; combinedPct: number; creatorIsFunder: boolean }[];
  bundle: { status: "NONE_OBSERVED" | "WEAK_SIGNAL" | "SUPPORTED" | "UNVERIFIED"; wallets: string[]; note: string };
  creatorLinkedPct: number | null;
  verifiedFacts: string[];
  suspected: string[];
  redFlags: string[];
  limitations: string[];
};

const round = (n: number) => Math.round(n * 100) / 100;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Creator = fee payer of the Pump.fun create transaction, where the mint itself co-signed. */
export function identifyCreator(
  tx: ParsedTx | null,
  mint: string,
  historyComplete: boolean,
): ForensicsReport["creator"] {
  const source = "Solana RPC: oldest mint transaction (getSignaturesForAddress + getTransaction)";
  if (!tx) return { wallet: null, status: "UNVERIFIED", source, evidence: "Creation transaction not retrieved" };
  if (!historyComplete)
    return { wallet: null, status: "UNVERIFIED", source, evidence: "Mint history too long to reach the creation transaction" };
  if (tx.failed) return { wallet: null, status: "UNVERIFIED", source, evidence: "Oldest transaction failed on-chain" };
  const pumpInvoked = tx.logs.some((l) => l.startsWith(`Program ${PUMP_PROGRAM_ID} invoke`));
  const createLog = tx.logs.some((l) => /^Program log: Instruction: Create(V2)?$/.test(l));
  const mintSigned = tx.signers.includes(mint);
  if (!pumpInvoked || !createLog || !mintSigned)
    return {
      wallet: null,
      status: "UNVERIFIED",
      source,
      evidence: `Oldest transaction is not a recognizable Pump.fun create (pump program: ${pumpInvoked}, create instruction: ${createLog}, mint signed: ${mintSigned})`,
    };
  return {
    wallet: tx.feePayer,
    status: "VERIFIED",
    source,
    evidence: `Fee payer of Pump.fun create tx ${tx.signature} (slot ${tx.slot}), co-signed by the mint`,
  };
}

export function analyzeForensics(input: ForensicsInput): ForensicsReport {
  const { supply, createTx } = input;
  const limitations = [...input.notes];
  const verifiedFacts: string[] = [];
  const suspected: string[] = [];
  const redFlags: string[] = [];

  const creator = identifyCreator(createTx, input.mint, input.historyComplete);
  if (creator.status === "VERIFIED") verifiedFacts.push(`Creator wallet ${creator.wallet} (${creator.evidence})`);
  else limitations.push(`Creator UNVERIFIED: ${creator.evidence}`);
  const creatorWallet = creator.wallet;

  // Bonding curve = largest receiver in the create tx that is not the creator.
  const exclude = new Set(input.excludeOwners);
  if (createTx && creator.status === "VERIFIED") {
    const curve = Object.entries(createTx.tokenDeltas)
      .filter(([o]) => o !== creatorWallet)
      .sort((a, b) => b[1] - a[1])[0];
    if (curve) exclude.add(curve[0]);
  }

  // Early acquisitions (gross buys; later sells are not netted out).
  const txs = input.earlyTxs === null ? null : [...(createTx && creator.status === "VERIFIED" ? [createTx] : []), ...input.earlyTxs];
  const createSlot = createTx?.slot ?? null;
  const acquired = new Map<string, { amount: number; slot: number; signature: string }>();
  let creatorSold: boolean | null = null;
  if (txs && supply > 0) {
    if (creatorWallet) creatorSold = false;
    for (const tx of txs) {
      if (tx.failed) continue;
      for (const [owner, delta] of Object.entries(tx.tokenDeltas)) {
        if (exclude.has(owner)) continue;
        if (owner === creatorWallet && delta < 0) creatorSold = true;
        // Only wallets that signed the tx count as buyers (pool vaults / program accounts never sign).
        if (delta <= 0 || !tx.signers.includes(owner)) continue;
        const prev = acquired.get(owner);
        if (prev) prev.amount += delta;
        else acquired.set(owner, { amount: delta, slot: tx.slot, signature: tx.signature });
      }
    }
  } else {
    limitations.push("Early transaction data unavailable: sniper and bundle checks not performed");
  }

  const pctOf = (w: string) => round(((acquired.get(w)?.amount ?? 0) / supply) * 100);
  const earlyBuyers = [...acquired.entries()]
    .map(([wallet, a]) => ({
      wallet,
      pct: round((a.amount / supply) * 100),
      slotOffset: createSlot === null ? -1 : a.slot - createSlot,
      signature: a.signature,
    }))
    .sort((a, b) => b.pct - a.pct);

  const creatorBuyPct = creatorWallet && txs ? pctOf(creatorWallet) : null;
  if (creatorBuyPct !== null && creatorBuyPct > 0) verifiedFacts.push(`Creator bought ${creatorBuyPct}% of supply at launch`);

  // Snipers: needs a known launch slot.
  const snipers =
    createSlot === null || creator.status !== "VERIFIED"
      ? []
      : earlyBuyers
          .filter((b) => b.wallet !== creatorWallet && b.slotOffset >= 0 && b.slotOffset <= SNIPER_MAX_SLOT_OFFSET && b.pct >= SNIPER_MIN_PCT)
          .map(({ wallet, pct, slotOffset }) => ({ wallet, pct, slotOffset }));
  for (const s of snipers)
    verifiedFacts.push(`Wallet ${short(s.wallet)} acquired ${s.pct}% within ${s.slotOffset} slot(s) of launch`);
  if (txs && createSlot === null) limitations.push("Launch slot unknown: sniper timing not evaluated");

  // Funding relationships.
  const byFunder = new Map<string, string[]>();
  for (const f of input.fundings) {
    if (!f.funder) continue;
    verifiedFacts.push(`${short(f.wallet)} received ${round((f.lamports ?? 0) / 1e9)} SOL from ${short(f.funder)} before buying (tx ${f.signature})`);
    byFunder.set(f.funder, [...(byFunder.get(f.funder) ?? []), f.wallet]);
  }
  if (input.fundingFailed.length) limitations.push(`Funding lookup failed for ${input.fundingFailed.length} early buyer(s)`);
  const fundingClusters = [...byFunder.entries()]
    .filter(([funder, ws]) => ws.length >= 2 || funder === creatorWallet)
    .map(([funder, wallets]) => ({
      funder,
      wallets,
      combinedPct: round(wallets.reduce((s, w) => s + pctOf(w), 0)),
      creatorIsFunder: funder === creatorWallet,
    }));
  for (const c of fundingClusters) {
    if (c.creatorIsFunder)
      suspected.push(`Creator funded ${c.wallets.length} early buyer(s) holding ${c.combinedPct}% at launch — likely insider wallets`);
    else
      suspected.push(
        `${c.wallets.length} early buyers (${c.combinedPct}% combined) were funded by the same wallet ${short(c.funder)} — possible coordination (could also be a shared exchange wallet)`,
      );
  }

  // Bundle: same-slot buys are only a weak signal unless funding links support it.
  let bundle: ForensicsReport["bundle"];
  if (!txs || createSlot === null || creator.status !== "VERIFIED") {
    bundle = { status: "UNVERIFIED", wallets: [], note: "Launch transactions unavailable" };
  } else {
    const sameSlot = earlyBuyers.filter((b) => b.wallet !== creatorWallet && b.slotOffset === 0).map((b) => b.wallet);
    const linked = sameSlot.filter((w) => fundingClusters.some((c) => c.wallets.includes(w)));
    if (!sameSlot.length) bundle = { status: "NONE_OBSERVED", wallets: [], note: "No other wallets bought in the launch slot" };
    else if (linked.length >= 2 || (linked.length >= 1 && fundingClusters.some((c) => c.creatorIsFunder && c.wallets.some((w) => linked.includes(w)))))
      bundle = { status: "SUPPORTED", wallets: linked, note: "Launch-slot buyers share a funding source" };
    else
      bundle = {
        status: "WEAK_SIGNAL",
        wallets: sameSlot,
        note: "Wallets bought in the launch slot, but no funding link was found — not proof of coordination",
      };
    if (bundle.status === "SUPPORTED") suspected.push(`Bundle: ${bundle.wallets.length} launch-slot buyers share funding`);
  }

  // Creator-linked concentration: creator + wallets the creator directly funded (verified transfers).
  let creatorLinkedPct: number | null = null;
  if (creatorWallet && txs) {
    const linked = new Set([creatorWallet, ...fundingClusters.filter((c) => c.creatorIsFunder).flatMap((c) => c.wallets)]);
    creatorLinkedPct = round([...linked].reduce((s, w) => s + pctOf(w), 0));
    if (creatorLinkedPct > CREATOR_LINKED_RED_FLAG_PCT)
      redFlags.push(`RED FLAG: creator and creator-funded wallets acquired ${creatorLinkedPct}% of supply (over ${CREATOR_LINKED_RED_FLAG_PCT}%)`);
  }

  // Creator history.
  const h = input.creatorHistory;
  const creatorHistory: ForensicsReport["creatorHistory"] = !creatorWallet
    ? { status: "UNVERIFIED", priorLaunchesSeen: null, txsChecked: 0, soldThisTokenInWindow: null, note: "Creator unknown" }
    : !h
      ? { status: "UNVERIFIED", priorLaunchesSeen: null, txsChecked: 0, soldThisTokenInWindow: creatorSold, note: "Creator history lookup failed" }
      : {
          status: "VERIFIED",
          priorLaunchesSeen: h.priorLaunches,
          txsChecked: h.txsChecked,
          soldThisTokenInWindow: creatorSold,
          note: `${h.priorLaunches} other Pump.fun launch(es) in the creator's last ${h.txsChecked} transactions${h.moreHistory ? " (older history not checked)" : ""}. Multiple launches alone are not evidence of fraud.`,
        };
  if (creatorWallet && !h) limitations.push("Creator history unavailable");
  if (h?.moreHistory) limitations.push("Creator history only partially checked");
  if (creatorSold) verifiedFacts.push("Creator sold some of this token within the observed early window");

  const coreMissing = creator.status !== "VERIFIED" || !txs;
  const anyMissing = coreMissing || input.fundingFailed.length > 0 || !h || input.notes.length > 0;
  const status = creator.status !== "VERIFIED" && !txs ? "UNVERIFIED" : anyMissing ? "PARTIAL" : "COMPLETE";

  return {
    status,
    creator,
    creatorHistory,
    creatorBuyPct,
    earlyBuyers: earlyBuyers.slice(0, 10),
    snipers,
    fundingClusters,
    bundle,
    creatorLinkedPct,
    verifiedFacts,
    suspected,
    redFlags,
    limitations,
  };
}
