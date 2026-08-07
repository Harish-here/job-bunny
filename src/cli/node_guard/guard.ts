/** The minimum Node major this CLI runs on — the repo ships TypeScript that
 * Node strips natively, with no build step. */
const MIN_NODE_MAJOR = 24;

export function nodeGuardMessage(version: string): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  if (!Number.isFinite(major)) return undefined;
  if (major >= MIN_NODE_MAJOR) return undefined;
  return `jobbunny needs Node >= ${MIN_NODE_MAJOR} (found ${version})`;
}
