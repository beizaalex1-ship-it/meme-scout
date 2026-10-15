const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

export async function sendTelegram(html: string) {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const tgKey = process.env["TELEGRAM_API_KEY"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!tgKey) throw new Error("Telegram is not connected");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set — add your channel ID first");
  const res = await fetch(`${GATEWAY_URL}/sendMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": tgKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Telegram failed [${res.status}]: ${body.slice(0, 300)}`);
  const json = JSON.parse(body) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
}
