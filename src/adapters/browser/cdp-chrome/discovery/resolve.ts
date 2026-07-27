import { chromeCandidates } from './candidates.ts';

/**
 * resolveCandidates (D11, §7.2) — three-tier Chrome candidate resolution.
 * First non-empty tier wins; the winner REPLACES the others, never
 * merges with them:
 *   1. JOBBUNNY_CHROME_PATH env var, if set and non-empty.
 *   2. `configured` (settings['cdp-chrome'].candidates from profile.json),
 *      if present and non-empty — used in full and in order, unchanged.
 *   3. chromeCandidates(platform, env) — the per-OS table.
 */
export function resolveCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  configured?: readonly string[],
): string[] {
  const override = env.JOBBUNNY_CHROME_PATH;
  if (override) return [override];
  if (configured && configured.length > 0) return configured.slice();
  return chromeCandidates(platform, env);
}
