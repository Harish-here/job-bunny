/**
 * Matching semantics (spec §6): case-insensitive, token-normalized.
 * Synonyms live in profile config, never in code.
 */

/** Fold a string to its matching form: lowercase, letters and digits only. */
export function normalizeToken(input: string): string {
  return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const LEGAL_SUFFIXES = new Set([
  'pvt',
  'ltd',
  'limited',
  'private',
  'inc',
  'incorporated',
  'llc',
  'llp',
  'gmbh',
]);

/** Company registry key (spec §5): "Acme Corp Pvt Ltd" → "acme-corp". */
export function companyKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last === undefined || !LEGAL_SUFFIXES.has(last)) break;
    words.pop();
  }
  return words.join('-');
}
