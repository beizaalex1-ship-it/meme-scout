import { describe, expect, it } from "vitest";
import { planCandidates } from "./optimizer";
import { analyzeSecurity } from "./rules";

const ok = { mintAuthority: null, freezeAuthority: null, extensions: [], transferFeeBps: 0, dexId: "pumpfun" };
const pass = analyzeSecurity(ok, "pumpfun");
const fail = analyzeSecurity({ ...ok, freezeAuthority: "X" }, "pumpfun");
const unv = analyzeSecurity(null, "pumpfun", "HTTP 429");

describe("credits optimizer", () => {
  it("only fully checks coins with verified PASS safety data, best first, up to the cap", () => {
    const p = planCandidates(
      [
        { item: "unv-high", quality: 100, security: unv },
        { item: "pass-low", quality: 5, security: pass },
        { item: "pass-high", quality: 50, security: pass },
        { item: "pass-mid", quality: 20, security: pass },
      ],
      2,
    );
    expect(p.analyze).toEqual(["pass-high", "pass-mid"]);
    expect(p.overCap).toEqual(["pass-low"]);
  });

  it("rejects verified FAIL coins early and skips unverified ones (never treats them as safe)", () => {
    const p = planCandidates([{ item: "f", quality: 9, security: fail }, { item: "u", quality: 9, security: unv }], 3);
    expect(p.earlyReject).toEqual(["f"]);
    expect(p.skippedUnverified).toEqual(["u"]);
    expect(p.analyze).toEqual([]);
  });
});
