/**
 * cli/wire/board_secrets.ts — `BoardSource.listSecrets`/`writeSecret`'s
 * real implementation, split out of `board.ts` purely for the file-size
 * cap (`board.ts` was already at its 400-line cap; task 11's `stopDaemon`
 * addition needed the room). Mirrors `board_daemon.ts`'s/`board_doctor.ts`'s
 * own precedent for splitting a `BoardSource` method's body out of
 * `board.ts` — this is a pure code move, not a behavior change: `board.ts`'s
 * own colocated test (`board.test.ts`) stays green unmodified as proof,
 * since it exercises these two methods only through the public
 * `BoardSource` interface, never these functions directly.
 *
 * Write-only, allowlisted (`SECRET_KEYS`): never reads a value back out,
 * never returns one — see `ports/board.ts`'s own doc comment on
 * `writeSecret` for the full contract, including why every write also
 * updates `process.env[key]` directly (the board process outlives the
 * one-time `.env` load in `main.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hasEnvValue, upsertEnvLine } from '../../core/env_file/index.ts';
import { SECRET_KEYS, type SecretKey, type SecretPresence } from '../../ports/board.ts';

/** `<root>/.env`'s current text, UTF-8. A missing file (ENOENT) reads as
 * the empty string, not an error — same tolerant posture as every other
 * "file may not exist yet" read in this module. */
async function readEnvText(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, '.env'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function listBoardSecrets(root: string): Promise<SecretPresence> {
  const text = await readEnvText(root);
  return Object.fromEntries(
    SECRET_KEYS.map((key) => [key, hasEnvValue(text, key) ? 'present' : 'absent']),
  ) as SecretPresence;
}

export async function writeBoardSecret(
  root: string,
  key: SecretKey,
  value: string,
  chmodEnvFile: (path: string, mode: number) => Promise<void>,
): Promise<void> {
  const text = await readEnvText(root);
  const updated = upsertEnvLine(text, key, value);
  const envPath = path.join(root, '.env');
  // `mode` on `writeFile` only applies when the file is CREATED — an
  // already-existing `.env` (the common case: most calls are updates to a
  // file `setup` already created) keeps whatever permissions it already
  // had unless chmod'd explicitly, so every write chmods the file to
  // `0o600` afterward regardless of whether it already existed.
  await writeFile(envPath, updated, { mode: 0o600 });
  await chmodEnvFile(envPath, 0o600);
  // `.env` is loaded exactly once, at CLI startup (`main.ts`'s
  // `dotenv.config`) — the long-lived board process never re-reads it.
  // Without this, `GET /api/profiles/:name/doctor` (which reads
  // `process.env` via `ops/doctor/aggregate.ts`'s `resolveEnv`) keeps
  // reporting the token missing until the server restarts, even though
  // `GET /api/secrets` (which re-reads the file) already says 'present' —
  // process-visible so the two endpoints agree.
  process.env[key] = value;
}
