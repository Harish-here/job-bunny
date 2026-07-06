// scripts/notifiers/telegram.js — Telegram channel for scripts/notify.js.
//
// Best-effort only: notifications must never break the calling pipeline stage. Every
// failure mode (missing token/chat_id, non-2xx response, network error, timeout)
// resolves via console.warn + return — this function NEVER throws.
//
// Plain text body, no `parse_mode` — Telegram's Markdown/HTML escaping is a real
// failure source (unescaped `_`/`*`/etc. in job titles or error text would break
// delivery); skipped for v1.

export async function sendTelegram({ chat_id, severity, title, body }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN missing — skipping send");
    return;
  }
  if (!chat_id) {
    console.warn("[telegram] chat_id missing — skipping send");
    return;
  }

  const prefix = severity ? `[${severity}] ` : "";
  const text = `${prefix}${title || ""}\n\n${body || ""}`.trim();

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "(no body)");
      console.warn(`[telegram] send failed (HTTP ${res.status}): ${errBody}`);
      return;
    }
  } catch (err) {
    console.warn(`[telegram] send failed: ${err.message}`);
    return;
  }
}
