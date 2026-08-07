/**
 * Resolves the Job Bunny data home directory.
 *
 * The home is the single directory containing all user data (profiles, DBs, .env, daemon pidfile, Chrome profile).
 * JOBBUNNY_HOME is read from the shell environment ONLY, never from .env — the .env file's location is derived
 * from the resolved home, so reading it from there would be circular.
 */

import { homedir as osHomedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = osHomedir,
): string {
  const override = env.JOBBUNNY_HOME;
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(homedir(), '.jobbunny');
}
