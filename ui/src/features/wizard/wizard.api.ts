import { getJson, putJson } from '../../lib/api/client';
import { type ConfigDocName, getConfigDoc, putConfigDoc } from '../settings/config.api';
import { SEED_PROFILE_CONFIG } from './serialize';
import type { DaemonStatus, PersonaCatalog, RunIntentView } from './wizard.types';

/** GET /api/personas -> { version, personas }. */
export function getPersonas(): Promise<PersonaCatalog> {
  return getJson('/api/personas');
}

/** GET /api/daemon -> { state, pid, startedAt, lastTickAt, inFlight, profiles }. */
export function getDaemonStatus(): Promise<DaemonStatus> {
  return getJson('/api/daemon');
}

/** PUT /api/secrets/:key, body { value } -> { key, status: 'present' }. The
 * resolved value is discarded — callers only need to know the write
 * succeeded; a failed write throws ApiError, same as every other write in
 * this module. */
export async function putSecret(
  key: 'NOTION_TOKEN' | 'TELEGRAM_BOT_TOKEN',
  value: string,
): Promise<void> {
  await putJson(`/api/secrets/${encodeURIComponent(key)}`, { value });
}

/** GET .../config/profile.json, JSON.parse of the returned `{ text }`.
 * Falls back to SEED_PROFILE_CONFIG when the text is empty (a freshly
 * created profile has an empty profile.json) or fails to parse — either
 * way this always returns a schema-valid document, never lets a bad read
 * propagate into a write. */
export async function readProfileConfig(
  profile: string,
): Promise<Record<string, unknown>> {
  const { text } = await getConfigDoc(profile, 'profile.json');
  if (text.trim() === '') return { ...SEED_PROFILE_CONFIG };
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...SEED_PROFILE_CONFIG };
  }
}

/** Read-modify-write: GET profile.json, apply `mutate` in place, PUT it
 * back. This is how steps 4, 5, and 6 each write their own slice of
 * profile.json without clobbering the others' fields. */
export async function patchProfileConfig(
  profile: string,
  mutate: (cfg: Record<string, unknown>) => void,
): Promise<void> {
  const cfg = await readProfileConfig(profile);
  mutate(cfg);
  await putConfigDoc(profile, 'profile.json', `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Thin wrapper over the existing putConfigDoc — kept here so every wizard
 * step imports its config writes from one module. */
export async function writeConfigDocText(
  profile: string,
  doc: ConfigDocName,
  text: string,
): Promise<void> {
  await putConfigDoc(profile, doc, text);
}

export type RunIntentOutcome =
  | { kind: 'queued'; intent: RunIntentView; deduped: boolean }
  | { kind: 'run_in_progress'; runId: number | null }
  | { kind: 'error'; message: string };

interface RunIntentErrorEnvelope {
  error?: { code?: string; message?: string; runId?: number | null };
}

/** POST /api/profiles/:name/run-intents, using RAW fetch instead of the
 * shared postJson. The shared ApiError keeps only status/code/message and
 * DROPS the extra `runId` a 409 carries — step 6's honest UI state ("A run
 * is already in progress", with the run's id) needs that field, so this
 * one function parses the response itself. This does NOT change
 * ui/src/lib/api/client.ts, and the raw-fetch path is confined to this
 * single function — nothing else in this module calls fetch directly. */
export async function requestRunIntent(profile: string): Promise<RunIntentOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/profiles/${encodeURIComponent(profile)}/run-intents`, {
      method: 'POST',
    });
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'network error',
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }

  if (res.status === 201 || res.status === 200) {
    const ok = body as { intent: RunIntentView; deduped: boolean };
    return { kind: 'queued', intent: ok.intent, deduped: ok.deduped };
  }

  const envelope = body as RunIntentErrorEnvelope | undefined;
  if (res.status === 409 && envelope?.error?.code === 'run_in_progress') {
    return { kind: 'run_in_progress', runId: envelope.error.runId ?? null };
  }
  return { kind: 'error', message: envelope?.error?.message ?? `HTTP ${res.status}` };
}
