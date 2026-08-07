/**
 * Pure string parsing/rewriting for `.env`-shaped text — no `node:fs`
 * import, no I/O of any kind. The wire layer (`cli/wire/board.ts`) is the
 * only place that reads/writes an actual file; everything fiddly about
 * comments, `export ` prefixes, quotes, and trailing newlines lives here
 * so it gets exhaustive unit tests without touching a filesystem.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A line "assigns `key`" when it matches `^\s*(?:export\s+)?KEY\s*=`
 * with `KEY` escaped for regex use. The capture group holds everything
 * after the `=`. */
function assignmentRegex(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=(.*)$`);
}

/** A line whose first non-whitespace character is `#` is a comment and
 * never matches an assignment. */
function isCommentLine(line: string): boolean {
  return /^\s*#/.test(line);
}

/** Trims the raw value, then strips one surrounding pair of matching
 * single or double quotes. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** `text` split into content lines, with at most one trailing empty
 * element (from a final `\n`) dropped — callers always rebuild with
 * `lines.join('\n') + '\n'`, so the trailing-newline bookkeeping never
 * leaks out of this one helper. */
function contentLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** True when `text` holds a non-comment assignment for `key` whose
 * value, trimmed and stripped of one surrounding pair of matching single
 * or double quotes, is non-empty. */
export function hasEnvValue(text: string, key: string): boolean {
  const regex = assignmentRegex(key);
  for (const line of contentLines(text)) {
    if (isCommentLine(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    if (unquote(match[1] ?? '').length > 0) return true;
  }
  return false;
}

/** A value containing whitespace or `#` would otherwise either get
 * silently truncated at the `#` (dotenv treats an unquoted `#` as a
 * comment starter) or pick up leading/trailing whitespace ambiguity; a
 * value containing a quote character would break out of a would-be
 * quoted form. Any of those get double-quoted; anything else is written
 * bare, matching every pre-existing `.env` line in the wild. */
function needsQuoting(value: string): boolean {
  return /[\s#"']/.test(value);
}

/** Double-quotes `value`, escaping embedded backslashes first (so a
 * pre-existing `\"` isn't double-escaped) and then embedded double
 * quotes. */
function quoteValue(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Returns `text` with `key` set to `value`. When a non-comment
 * assignment for `key` already exists, the FIRST such line is replaced
 * whole (as a plain `KEY=value` line, even if the original was
 * `export`-prefixed) and every other line is preserved byte-for-byte;
 * otherwise `KEY=value` is appended. The result always ends in exactly
 * one trailing newline. `value` is double-quoted (with embedded quotes
 * and backslashes escaped) whenever it contains whitespace, `#`, or a
 * quote character — otherwise it's written bare; callers reject values
 * containing a newline before calling either way. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const regex = assignmentRegex(key);
  const lines = contentLines(text);
  const index = lines.findIndex((line) => !isCommentLine(line) && regex.test(line));
  const written = needsQuoting(value) ? quoteValue(value) : value;
  const newLine = `${key}=${written}`;
  if (index === -1) {
    lines.push(newLine);
  } else {
    lines[index] = newLine;
  }
  return `${lines.join('\n')}\n`;
}
