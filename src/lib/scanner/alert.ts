import { escapeHtml as e } from "./rules";

export type AlertInput = {
  name: string;
  symbol: string;
  mint: string;
  score: number;
  bullets: string[];
  takeaway: string;
  marketCapUsd: number | null;
};

export function formatAlert(a: AlertInput, test = false) {
  const mc = a.marketCapUsd ? `$${Math.round(a.marketCapUsd).toLocaleString("en-US")}` : "n/a";
  return [
    test ? "🧪 <b>TEST ALERT — sample data</b>\n" : "",
    `🚨 <b>${e(a.name)}</b> ($${e(a.symbol)})`,
    `<b>CA:</b> <code>${e(a.mint)}</code>`,
    `<b>Opportunity Score:</b> ${a.score}/100  •  <b>MC:</b> ${mc}`,
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
