export async function sendTelegram(html: string) {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set — add your chat ID first");
  // The token is part of the URL by Telegram's design; it is never logged here.
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Telegram failed [${res.status}]: ${body.slice(0, 200).replaceAll(token, "***")}`);
  const json = JSON.parse(body) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
}
