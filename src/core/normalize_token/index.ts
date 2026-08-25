/** Fold a string to its matching form: lowercase, letters and digits only. */
export function normalizeToken(input: string): string {
  return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
