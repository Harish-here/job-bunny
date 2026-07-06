// scripts/notifiers/telegram.js — Telegram channel for scripts/notify.js.
//
// Best-effort only: notifications must never break the calling pipeline stage. Every
// failure mode (missing token/chat_id, non-2xx response, network error, timeout)
// resolves via console.warn + return — this function NEVER throws.
//
// Plain text body, no `parse_mode` — Telegram's Markdown/HTML escaping is a real
// failure source (unescaped `_`/`*`/etc. in job titles or error text would break
// delivery); skipped for v1. Instead, telegram_format.js renders a banner + bold
// headings/labels + bulleted tables using Unicode "fake bold" characters — a text
// transform, not markup, so it can never cause a parse/send failure. If that
// formatting ever throws for any reason, this file falls back to the old plain
// concatenation rather than losing the send entirely (see sendTelegram() below).
//
// Bot token resolution: most setups share one bot across all profiles
// (TELEGRAM_BOT_TOKEN, same precedent as NOTION_TOKEN). A profile that wants its own
// separate bot (e.g. two different people, each with their own @BotFather bot) can
// override with a per-profile env key instead — see telegramTokenEnvKey().

import { formatTelegramMessage } from "./telegram_format.js";

// Profile names are lowercase letters/digits/hyphens only (enforced by init.js) — upper-cased
// with hyphens turned into underscores gives a valid env var name.
export function telegramTokenEnvKey(profileName) {
  return `TELEGRAM_BOT_TOKEN_${String(profileName).toUpperCase().replace(/-/g, "_")}`;
}

export async function sendTelegram({ chat_id, severity, title, body, profileName }) {
  const perProfileKey = profileName ? telegramTokenEnvKey(profileName) : null;
  const token = (perProfileKey && process.env[perProfileKey]) || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN missing — skipping send");
    return;
  }
  if (!chat_id) {
    console.warn("[telegram] chat_id missing — skipping send");
    return;
  }

  let text;
  try {
    text = formatTelegramMessage({ severity, title, body, profileName });
  } catch (err) {
    console.warn(`[telegram] formatting failed (${err.message}) — falling back to plain text`);
    const prefix = severity ? `[${severity}] ` : "";
    text = `${prefix}${title || ""}\n\n${body || ""}`.trim();
  }

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
