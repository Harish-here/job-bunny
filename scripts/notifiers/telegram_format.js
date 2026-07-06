// scripts/notifiers/telegram_format.js — pure text-transform helpers for the Telegram
// channel. No I/O, no env, no fetch — telegram.js owns "how to send," this module owns
// "what the text looks like." Every export is a pure function of its inputs.
//
// No Telegram `parse_mode` is used anywhere downstream (see telegram.js) — real markup
// escaping is a reliability risk since job titles/error text flow in unescaped. Instead,
// "bold" here means swapping in different Unicode codepoints (Mathematical Alphanumeric
// Symbols), which can never cause a parse/send failure the way malformed markup would.

const BOLD_UPPER_BASE = 0x1d400; // 𝐀
const BOLD_LOWER_BASE = 0x1d41a; // 𝐚
const BOLD_DIGIT_BASE = 0x1d7ce; // 𝟎

function boldChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x41 && cp <= 0x5a) return String.fromCodePoint(BOLD_UPPER_BASE + (cp - 0x41)); // A-Z
  if (cp >= 0x61 && cp <= 0x7a) return String.fromCodePoint(BOLD_LOWER_BASE + (cp - 0x61)); // a-z
  if (cp >= 0x30 && cp <= 0x39) return String.fromCodePoint(BOLD_DIGIT_BASE + (cp - 0x30)); // 0-9
  return ch; // punctuation, spaces, emoji, accented/non-Latin — no bold-plane equivalent, left as-is
}

// The bold codepoints above are outside the BMP, so each becomes a UTF-16 surrogate pair
// once in a JS string. Must iterate by codepoint (Array.from), never charCodeAt/index —
// naive indexing would split a pair and corrupt output.
export function toBoldUnicode(str) {
  return Array.from(String(str ?? ""))
    .map(boldChar)
    .join("");
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line) => /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/.test(line);
const splitTableRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function tableRowToBullet(cells) {
  const nonEmpty = cells.filter(Boolean);
  if (!nonEmpty.length) return null;
  const [first, ...rest] = nonEmpty;
  return `• ${toBoldUnicode(first)}${rest.length ? " — " + rest.join(" — ") : ""}`;
}

function boldInlineSpans(line) {
  return line.replace(/\*\*(.+?)\*\*/g, (_, inner) => toBoldUnicode(inner));
}

// Three-stage line pipeline: (1) markdown tables → bullet lines, generic across any table
// shape, not just the one "Score | Title | Company" example; (2) # / ## headings → bolded,
// markers stripped; (3) inline **bold** spans → bolded, markers stripped (also catches bold
// labels inside bullet lines like "- **URLs processed:** 21").
export function reformatBody(body) {
  const lines = String(body ?? "").split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      i += 2; // skip header row + separator row — redundant once bulleted
      while (i < lines.length && isTableRow(lines[i])) {
        const bullet = tableRowToBullet(splitTableRow(lines[i]));
        if (bullet) out.push(bullet);
        i++;
      }
      i--; // outer loop's i++ will advance past the last consumed row
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(toBoldUnicode(heading[2]));
      continue;
    }

    out.push(boldInlineSpans(line));
  }

  return out.join("\n");
}

const SEVERITY_ICONS = { blocking: "🔴", success: "✅", info: "ℹ️" };
export function severityIcon(severity) {
  return SEVERITY_ICONS[severity] || "🔔"; // forward-compatible fallback for an unmapped severity
}

// Telegram's sendMessage caps text at 4096 UTF-16 code units. Leave headroom and slice by
// codepoint array (not raw string index) — same surrogate-pair reasoning as toBoldUnicode.
const SAFE_LIMIT = 3800;
const TRUNCATION_NOTE = "\n\n…(truncated — see log)";

export function truncate(text) {
  const codepoints = Array.from(text);
  if (codepoints.length <= SAFE_LIMIT) return text;
  return codepoints.slice(0, SAFE_LIMIT).join("") + TRUNCATION_NOTE;
}

// A visible rule between the envelope (banner + optional title) and the content — both are
// bold text and blend together with only a blank line between them, especially when the body
// starts with its own bold heading (e.g. the Run Summary's "Run Summary — profile: X").
const SEPARATOR = "────────────────";

export function formatTelegramMessage({ severity, title, body, profileName }) {
  const banner = `${severityIcon(severity)} Job Bunny${profileName ? ` — ${profileName}` : ""}`;
  const boldTitle = title ? toBoldUnicode(title) : "";
  const formattedBody = reformatBody(body || "");
  const header = [banner, boldTitle].filter((p) => p !== "").join("\n");
  const parts = [header, SEPARATOR, formattedBody].filter((p) => p !== "");
  return truncate(parts.join("\n\n").trim());
}
