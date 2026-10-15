import { describe, expect, it } from "vitest";
import { analyzeForensics, identifyCreator, PUMP_PROGRAM_ID, type ForensicsInput, type ParsedTx } from "./forensics";
import { parseTx } from "./forensics.server";
import { analyzeWallets, shouldReject } from "./rules";

const MINT = "Mintpump";
const SUPPLY = 1_000_000_000;
const tx = (p: Partial<ParsedTx>): ParsedTx => ({
  signature: "s",
  slot: 100,
  blockTime: null,
  failed: false,
  feePayer: "X",
  signers: [],
  logs: [],
  tokenDeltas: {},
  solTransfers: [],
  ...p,
});
const createTx = (devPct = 2) =>
  tx({
    signature: "create",
    slot: 100,
    feePayer: "DEV",
    signers: ["DEV", MINT],
    logs: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: CreateV2"],
    tokenDeltas: { CURVE: SUPPLY * (1 - devPct / 100), DEV: (SUPPLY * devPct) / 100 },
  });
const buy = (wallet: string, pct: number, slot: number, sig = `b-${wallet}`) =>
  tx({ signature: sig, slot, feePayer: wallet, signers: [wallet], tokenDeltas: { [wallet]: (SUPPLY * pct) / 100, CURVE: (-SUPPLY * pct) / 100 } });
const input = (p: Partial<ForensicsInput> = {}): ForensicsInput => ({
  mint: MINT,
  supply: SUPPLY,
  createTx: createTx(),
  historyComplete: true,
  earlyTxs: [],
  excludeOwners: ["POOL"],
  fundings: [],
  fundingFailed: [],
  creatorHistory: { txsChecked: 4, priorLaunches: 0, moreHistory: false },
  notes: [],
  ...p,
});

describe("creator identification", () => {
  it("identifies the creator as fee payer of the Pump.fun create tx co-signed by the mint", () => {
    const c = identifyCreator(createTx(), MINT, true);
    expect(c.status).toBe("VERIFIED");
    expect(c.wallet).toBe("DEV");
  });

  it("marks the creator UNVERIFIED when the tx is not a Pump.fun create", () => {
    expect(identifyCreator(tx({ feePayer: "DEV", signers: ["DEV"] }), MINT, true).status).toBe("UNVERIFIED");
  });

  it("marks the creator UNVERIFIED when creation data is missing or history incomplete", () => {
    expect(identifyCreator(null, MINT, true)).toMatchObject({ status: "UNVERIFIED", wallet: null });
    expect(identifyCreator(createTx(), MINT, false)).toMatchObject({ status: "UNVERIFIED", wallet: null });
  });
});

describe("early buyers, snipers, funding", () => {
  it("flags wallets funded by the same source as suspected, keeping the transfers as verified facts", () => {
    const r = analyzeForensics(
      input({
        earlyTxs: [buy("A", 3, 105), buy("B", 4, 106)],
        fundings: [
          { wallet: "A", funder: "F", signature: "fa", slot: 90, lamports: 1e9 },
          { wallet: "B", funder: "F", signature: "fb", slot: 91, lamports: 1e9 },
        ],
      }),
    );
    expect(r.fundingClusters).toEqual([{ funder: "F", wallets: ["A", "B"], combinedPct: 7, creatorIsFunder: false }]);
    expect(r.suspected.length).toBe(1);
    expect(r.verifiedFacts.filter((f) => f.includes("SOL from")).length).toBe(2);
    expect(r.redFlags).toEqual([]);
  });

  it("detects snipers: large buys within 2 slots of launch", () => {
    const r = analyzeForensics(input({ earlyTxs: [buy("S", 8, 101), buy("L", 8, 140), buy("tiny", 0.5, 100)] }));
    expect(r.snipers).toEqual([{ wallet: "S", pct: 8, slotOffset: 1 }]);
  });

  it("raises a red flag when creator plus creator-funded wallets exceed 30%", () => {
    const r = analyzeForensics(
      input({
        createTx: createTx(10),
        earlyTxs: [buy("A", 15, 100), buy("B", 10, 101)],
        fundings: [
          { wallet: "A", funder: "DEV", signature: "f1", slot: 99, lamports: 2e9 },
          { wallet: "B", funder: "DEV", signature: "f2", slot: 99, lamports: 2e9 },
        ],
      }),
    );
    expect(r.creatorLinkedPct).toBe(35);
    expect(r.redFlags.length).toBe(1);
    expect(r.bundle.status).toBe("SUPPORTED");
    expect(shouldReject({ verdict: "PASS", mintAuthorityDisabled: true, freezeAuthorityDisabled: true, liquidity: "", flags: [] }, analyzeWallets({ pcts: [2], excluded: 1 }, undefined, r))).toBe(true);
  });
});

describe("false-positive prevention", () => {
  it("treats same-slot buys without funding links as a weak signal only", () => {
    const r = analyzeForensics(input({ earlyTxs: [buy("A", 1, 100), buy("B", 1, 100)] }));
    expect(r.bundle.status).toBe("WEAK_SIGNAL");
    expect(r.suspected).toEqual([]);
    expect(r.redFlags).toEqual([]);
  });

  it("does not flag a creator merely for launching many tokens", () => {
    const r = analyzeForensics(input({ creatorHistory: { txsChecked: 4, priorLaunches: 4, moreHistory: false } }));
    expect(r.creatorHistory.priorLaunchesSeen).toBe(4);
    expect(r.redFlags).toEqual([]);
    expect(r.suspected).toEqual([]);
  });

  it("does not count the bonding curve as a buyer", () => {
    const r = analyzeForensics(input({ earlyTxs: [buy("A", 1, 105)] }));
    expect(r.earlyBuyers.map((b) => b.wallet).sort()).toEqual(["A", "DEV"]);
  });
});

describe("incomplete data", () => {
  it("reports UNVERIFIED forensics and never Safe when transaction history is unavailable", () => {
    const r = analyzeForensics(input({ createTx: null, earlyTxs: null, creatorHistory: null }));
    expect(r.status).toBe("UNVERIFIED");
    expect(r.bundle.status).toBe("UNVERIFIED");
    expect(analyzeWallets({ pcts: [1, 1], excluded: 1 }, undefined, r).risk).toBe("Unverified");
  });

  it("is PARTIAL when the launch window could not be reached", () => {
    const r = analyzeForensics(input({ historyComplete: false, notes: ["Mint has more than 2000 transactions"] }));
    expect(r.status).toBe("PARTIAL");
    expect(r.creator.status).toBe("UNVERIFIED");
  });

  it("is PARTIAL when a funding lookup failed", () => {
    expect(analyzeForensics(input({ fundingFailed: ["A"] })).status).toBe("PARTIAL");
  });

  it("only rates Safe when holders and forensics are both complete", () => {
    expect(analyzeWallets({ pcts: [1], excluded: 1 }, undefined, analyzeForensics(input())).risk).toBe("Safe");
    expect(analyzeWallets({ pcts: [1], excluded: 1 }).risk).toBe("Unverified");
  });
});

describe("parseTx", () => {
  it("extracts token deltas and SOL transfers from jsonParsed RPC data", () => {
    const p = parseTx(
      {
        slot: 5,
        blockTime: 1,
        meta: {
          err: null,
          logMessages: [],
          preTokenBalances: [{ mint: MINT, owner: "A", uiTokenAmount: { uiAmount: 10 } }],
          postTokenBalances: [{ mint: MINT, owner: "A", uiTokenAmount: { uiAmount: 25 } }],
          innerInstructions: [{ instructions: [{ program: "system", parsed: { type: "transfer", info: { source: "F", destination: "A", lamports: 5 } } }] }],
        },
        transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: "A", signer: true }], instructions: [] } },
      },
      MINT,
    );
    expect(p.tokenDeltas).toEqual({ A: 15 });
    expect(p.solTransfers).toEqual([{ from: "F", to: "A", lamports: 5 }]);
    expect(p.feePayer).toBe("A");
  });
});
