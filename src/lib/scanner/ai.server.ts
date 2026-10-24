import { createAnthropic } from "@ai-sdk/anthropic";
import { NoObjectGeneratedError, Output, streamText } from "ai";
import { z } from "zod";

const MODEL = process.env["AI_MODEL"] ?? "claude-sonnet-5-5";

export const aiSchema = z.object({
  social: z.object({
    score: z.number().int().min(1).max(10),
    hype: z.enum(["organic", "automated", "unclear"]),
    summary: z.string().describe("Exactly 2 sentences on the prevailing narrative."),
  }),
  opportunity: z.object({
    score: z.number().int().min(1).max(100),
    bullCase: z.string(),
    bearCase: z.string(),
  }),
  chief: z.object({
    bullets: z.array(z.string()).describe("3 short bullets: market momentum, social sentiment, wallet health"),
    takeaway: z.string().describe("One-line final verdict / actionable takeaway"),
  }),
});
export type AiReport = z.infer<typeof aiSchema>;

export class AiGatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const INSTRUCTIONS = `You run three agents in a Solana Pump.fun meme-coin research pipeline. Use ONLY the evidence provided; never invent data. If security.verdict is UNVERIFIED or wallet.verified is false, say so plainly, treat it as a major risk, and never describe the token as safe or security-approved. In wallet.forensics, verifiedFacts are on-chain facts; suspected items are inferences — always call them suspected, never confirmed. A creator launching several tokens is not by itself evidence of fraud.

Agent 3 — Social Intelligence: from the token's name, description, listed website/X/Telegram links and DexScreener boost/profile status, judge narrative strength. Free sources only: no live X search is available, so missing socials lower the score and say "unclear" when you can't tell organic from automated. Score 1-10 and write a 2-sentence narrative summary.

Agent 6 — Opportunity Analyst: weigh upside (market-cap room to grow, momentum, social) against downside (holder concentration, sell pressure, missing data, wash-trading flags). Give a Risk-Adjusted Score 1-100 (70+ only for genuinely strong setups) plus a brief bull case and bear case.

Agent 7 — Chief Research Agent: write 3 punchy bullets (market momentum, social sentiment, wallet health) and a one-line final verdict for a Telegram alert. Not financial advice tone; be factual and concise.`;

export async function runAiAgents(evidence: unknown): Promise<AiReport> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new AiGatewayError(401, "ANTHROPIC_API_KEY is not configured");

  let failStatus: number | null = null;
  let failBody = "";
  const provider = createAnthropic({
    apiKey,
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (!res.ok) {
        failStatus = res.status;
        failBody = await res.clone().text();
      }
      return res;
    },
  });

  const result = streamText({
    model: provider(MODEL),
    system: INSTRUCTIONS,
    prompt: `Evidence from agents 1, 2, 4 and 5:\n${JSON.stringify(evidence, null, 2)}`,
    output: Output.object({ schema: aiSchema }),
    onError: () => {},
  });

  try {
    await result.consumeStream();
    const out = await result.output;
    return out;
  } catch (e) {
    if (failStatus) throw new AiGatewayError(failStatus, failBody.slice(0, 300));
    if (NoObjectGeneratedError.isInstance(e)) throw new Error("AI returned an unreadable report");
    throw e;
  }
}
