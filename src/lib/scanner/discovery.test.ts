import { describe, expect, it } from "vitest";
import { extractLaunchMint, planHeliusBudget, selectSignatures } from "./discovery";
import { PUMP_PROGRAM_ID } from "./forensics";

const MINT = "AGmksq6hBGQi4bU5SFy3VH6gYy2R1YYKxeCiniLUpump";
const tx = (over: Record<string, unknown> = {}) => ({
  meta: {
    err: null,
    logMessages: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: CreateV2"],
    postTokenBalances: [{ mint: MINT }],
    ...over,
  },
  transaction: { message: { accountKeys: [{ pubkey: "Payer111", signer: true }, { pubkey: MINT, signer: true }, { pubkey: "X", signer: false }] } },
});

describe("extractLaunchMint", () => {
  it("extracts the mint from a valid create", () => expect(extractLaunchMint(tx())).toEqual({ ok: true, mint: MINT }));
  it("rejects malformed data", () => {
    expect(extractLaunchMint(null).ok).toBe(false);
    expect(extractLaunchMint({} as never).ok).toBe(false);
    expect(extractLaunchMint({ meta: {}, transaction: { message: { accountKeys: "x" } } } as never).ok).toBe(false);
  });
  it("rejects failed or non-create txs", () => {
    expect(extractLaunchMint(tx({ err: { x: 1 } })).ok).toBe(false);
    expect(extractLaunchMint(tx({ logMessages: [`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Buy"] })).ok).toBe(false);
    expect(extractLaunchMint(tx({ logMessages: ["Program log: Instruction: Create"] })).ok).toBe(false);
  });
  it("ignores the fee payer as a mint", () => expect(extractLaunchMint(tx({ postTokenBalances: [{ mint: "Payer111" }] })).ok).toBe(false));
});

describe("selectSignatures", () => {
  const now = 10_000;
  const sigs = [
    { signature: "new", blockTime: now - 30 }, // too new
    { signature: "a", blockTime: now - 120 },
    { signature: "b", blockTime: now - 300 },
    { signature: "old", blockTime: now - 900 }, // over 10 min
    { signature: "bad", blockTime: now - 200, err: { e: 1 } },
  ];
  it("keeps the age window and drops failures", () => expect(selectSignatures(sigs, new Set(), now, 10, 10).picked.map((s) => s.signature)).toEqual(["a", "b"]));
  it("skips already-processed launches (duplicates)", () => expect(selectSignatures(sigs, new Set(["a"]), now, 10, 10).picked.map((s) => s.signature)).toEqual(["b"]));
  it("recovers launches missed during an outage while still in the window", () => {
    // Previous scan processed only "a" (cap 1); next scan picks up "b".
    const first = selectSignatures(sigs, new Set(), now, 10, 1).picked.map((s) => s.signature);
    const next = selectSignatures(sigs, new Set(first), now, 10, 1).picked.map((s) => s.signature);
    expect(first).toEqual(["a"]);
    expect(next).toEqual(["b"]);
  });
});

describe("planHeliusBudget", () => {
  it("caps at the per-scan limit", () => expect(planHeliusBudget({ monthlyBudget: 1_000_000, usedThisMonth: 0, maxCoins: 3, maxTx: 30 }).allowedTx).toBe(30));
  it("stops when the budget minus reserve is used", () => {
    const r = planHeliusBudget({ monthlyBudget: 1000, usedThisMonth: 900, maxCoins: 3, maxTx: 30 });
    expect(r.allowedTx).toBe(0);
    expect(r.reason).toMatch(/budget/);
  });
  it("never plans beyond what is left", () => expect(planHeliusBudget({ monthlyBudget: 1000, usedThisMonth: 280, maxCoins: 3, maxTx: 30 }).allowedTx).toBe(5));
});
