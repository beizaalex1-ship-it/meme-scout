import type { ForensicsReport } from "./forensics";
import { escapeHtml as e } from "./rules";

export type AlertInput = {
  name: string;
  symbol: string;
  mint: string;
  score: number;
  bullets: string[];
  takeaway: string;
  marketCapUsd: number | null;
  security?: "PASS" | "FAIL" | "UNVERIFIED";
  holdersVerified?: boolean;
  forensics?: ForensicsReport;
};

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Wallet Investigator block: verified facts, suspected links and incomplete-check warnings, kept separate. */
export function formatWalletSection(f: ForensicsReport | undefined): string[] {
  if (!f) return ["🔎 <b>Wallet checks:</b> ⚠️ UNVERIFIED — not performed"];
  const out: string[] = [`🔎 <b>Wallet checks:</b> ${f.status === "COMPLETE" ? "complete" : f.status === "PARTIAL" ? "⚠️ partial" : "⚠️ UNVERIFIED"}`];
  const verified: string[] = [];
  if (f.creator.status === "VERIFIED" && f.creator.wallet) {
    const h = f.creatorHistory;
    let c = `Creator <code>${e(short(f.creator.wallet))}</code>`;
    if (f.creatorBuyPct !== null) c += ` bought ${f.creatorBuyPct}%`;
    if (h.priorLaunchesSeen !== null) c += `, ${h.priorLaunchesSeen} other launch(es) in last ${h.txsChecked} txs`;
    if (h.soldThisTokenInWindow) c += ", has sold some";
    verified.push(c);
  }
  const buyers = f.earlyBuyers.filter((b) => b.wallet !== f.creator.wallet).slice(0, 3);
  if (buyers.length)
    verified.push(`Top early buyers: ${buyers.map((b) => `${e(short(b.wallet))} ${b.pct}% (+${b.slotOffset} slots)`).join(", ")}`);
  for (const s of f.snipers.slice(0, 3)) verified.push(`Sniper ${e(short(s.wallet))}: ${s.pct}% within ${s.slotOffset} slot(s)`);
  for (const r of f.redFlags) verified.push(`🚩 ${e(r)}`);
  if (verified.length) out.push("<b>Verified:</b>", ...verified.map((v) => `✅ ${v}`));

  const suspected = [...f.suspected];
  if (f.bundle.status === "WEAK_SIGNAL") suspected.push(`Weak signal: ${f.bundle.wallets.length} wallet(s) bought in the launch slot (no funding link found)`);
  if (suspected.length) out.push("<b>Suspected (not confirmed):</b>", ...suspected.slice(0, 4).map((s) => `❓ ${e(s)}`));

  const warn = f.limitations.slice(0, 4);
  if (warn.length) out.push("<b>Incomplete checks:</b>", ...warn.map((w) => `⚠️ ${e(w)}`));
  return out;
}

export function formatAlert(a: AlertInput, test = false) {
  const mc = a.marketCapUsd ? `$${Math.round(a.marketCapUsd).toLocaleString("en-US")}` : "n/a";
  return [
    test ? "🧪 <b>TEST ALERT — sample data</b>\n" : "",
    `🚨 <b>${e(a.name)}</b> ($${e(a.symbol)})`,
    `<b>CA:</b> <code>${e(a.mint)}</code>`,
    `<b>Opportunity Score:</b> ${a.score}/100  •  <b>MC:</b> ${mc}`,
    a.security
      ? `🛡 <b>Security:</b> ${a.security === "PASS" ? "PASS (on-chain verified)" : a.security === "UNVERIFIED" ? "⚠️ UNVERIFIED — checks could not be completed" : "FAIL"}  •  <b>Holders:</b> ${a.holdersVerified ? "verified" : "⚠️ unverified"}`
      : "",
    ...(a.forensics !== undefined || a.security ? ["", ...formatWalletSection(a.forensics)] : []),
    "",
    ...a.bullets.map((b) => `• ${e(b)}`),
    "",
    `🎯 <b>Verdict:</b> ${e(a.takeaway)}`,
    `<a href="https://dexscreener.com/solana/${e(a.mint)}">DexScreener</a> | <a href="https://pump.fun/coin/${e(a.mint)}">Pump.fun</a>`,
    "<i>Not financial advice. DYOR.</i>",
  ]
    .filter((l, i) => !(i === 0 && !l))
    .join("\n");
}
