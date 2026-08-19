/**
 * Matching semantics (spec §6): case-insensitive, token-normalized.
 * Synonyms live in profile config, never in code.
 */

export { normalizeToken } from '../normalize_token/index.ts';

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
