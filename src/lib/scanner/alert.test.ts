import { describe, expect, it } from "vitest";
import { formatAlert } from "./alert";
import { analyzeForensics, PUMP_PROGRAM_ID } from "./forensics";

const base = { name: "T", symbol: "T", mint: "Mpump", score: 30, bullets: [], takeaway: "x", marketCapUsd: 5000, security: "PASS" as const, holdersVerified: true };
const create = {
  signature: "c", slot: 1, blockTime: null, failed: false, feePayer: "DEVWALLET1", signers: ["DEVWALLET1", "Mpump"],
  logs: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Create"], tokenDeltas: { CURVE: 9.9e8, DEVWALLET1: 1e7 }, solTransfers: [],
};
const buy = (w: string) => ({ ...create, signature: w, slot: 2, feePayer: w, signers: [w], logs: [], tokenDeltas: { [w]: 2e7 } });

describe("Telegram alert wallet section", () => {
  it("shows verified creator/buyers and labels shared funding as suspected", () => {
    const f = analyzeForensics({
      mint: "Mpump", supply: 1e9, createTx: create, historyComplete: true, earlyTxs: [buy("BUYERAAAA1"), buy("BUYERBBBB2")],
      excludeOwners: [], fundingFailed: [], notes: [], creatorHistory: { txsChecked: 4, priorLaunches: 1, moreHistory: false },
      fundings: [
        { wallet: "BUYERAAAA1", funder: "FUNDER", signature: "f1", slot: 0, lamports: 1e9 },
        { wallet: "BUYERBBBB2", funder: "FUNDER", signature: "f2", slot: 0, lamports: 1e9 },
      ],
    });
    const text = formatAlert({ ...base, forensics: f });
    expect(text).toContain("Creator <code>DEVW…LET1</code> bought 1%");
    expect(text).toContain("Suspected (not confirmed)");
    expect(text).toContain("funded by the same wallet");
  });

  it("warns when wallet checks were not performed or incomplete", () => {
    expect(formatAlert(base)).toContain("UNVERIFIED — not performed");
    const f = analyzeForensics({
      mint: "Mpump", supply: 1e9, createTx: null, historyComplete: true, earlyTxs: null, excludeOwners: [],
      fundings: [], fundingFailed: [], creatorHistory: null, notes: [],
    });
    const text = formatAlert({ ...base, forensics: f });
    expect(text).toContain("Incomplete checks");
    expect(text).toContain("Creator UNVERIFIED");
  });
});

import { formatAlert as fa } from "./alert";
describe("dex paid line", () => {
  const base = { name: "A", symbol: "A", mint: "m", score: 5, bullets: [], takeaway: "t", marketCapUsd: null };
  it("shows paid", () => expect(fa({ ...base, dexPaid: { status: "PAID", boosts: 0 } })).toContain("DEX paid:</b> ✅ Yes"));
  it("unknown is never shown as paid", () => expect(fa({ ...base, dexPaid: { status: "UNKNOWN", boosts: 0 } })).toContain("Unknown"));
});
