import { ApiError, getJson, putJson } from '../../lib/api/client';
import type {
  AutostartOutcome,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../lib/api/types';
import { patchProfileConfig } from '../wizard/wizard.api';

const STOP_OUTCOMES: ReadonlySet<string> = new Set<StopDaemonOutcome['outcome']>([
  'stopped',
  'already_stopped',
  'daemon_unresponsive',
  'child_unresponsive',
  'stale_pidfile',
]);

const START_OUTCOMES: ReadonlySet<string> = new Set<StartDaemonOutcome['outcome']>([
  'started',
  'already_running',
  'spawn_failed',
]);

function isValueShapedOutcome(
  status: number,
  body: unknown,
  validOutcomes: ReadonlySet<string>,
): boolean {
  if (status !== 409 && status !== 500) return false;
  if (typeof body !== 'object' || body === null || !('outcome' in body)) return false;
  const outcome = (body as { outcome: unknown }).outcome;
  return typeof outcome === 'string' && validOutcomes.has(outcome);
}

/** POSTs `path` with an empty JSON body and returns the parsed body as `T`
 * for a 2xx response, exactly like `postJson`. UNLIKE `postJson`, a 409 or
 * 500 response whose body parses to `{ outcome: <string in validOutcomes> }`
 * also resolves with that body rather than throwing — this is the shape
 * `app/features/daemon/routes.ts` deliberately returns for
 * `StopDaemonOutcome`'s `daemon_unresponsive`/`child_unresponsive`/
 * `stale_pidfile` (409) and `StartDaemonOutcome`'s `spawn_failed` (500), per
 * that route's own doc comment — never an `{error:...}` envelope. Any other
 * non-2xx status, or a 409/500 whose body isn't one of those value shapes
 * (e.g. autostart's 409 `autostart_conflict`, a genuine `HttpError`), still
 * throws `ApiError` exactly as `postJson` would. Local to this module —
 * `postJson`'s generic throw-on-non-2xx contract is unchanged for every
 * other caller. */
async function postForOutcome<T>(
  path: string,
  validOutcomes: ReadonlySet<string>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    throw new ApiError(
      0,
      'network',
      err instanceof Error ? err.message : 'network error',
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    if (isValueShapedOutcome(res.status, body, validOutcomes)) {
      return body as T;
    }
    const envelope = body as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? 'unknown',
      envelope?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  if (body === undefined) {
    throw new ApiError(res.status, 'bad_response', 'malformed response body');
  }
  return body as T;
}

export type DoctorStatus = 'ok' | 'warn' | 'red';

export interface DoctorFinding {
  check: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  findings: DoctorFinding[];
}

/** GET /api/profiles/:name/doctor -> { status, findings }. `findings` is
 * unsorted and untransformed — grouping and severity ordering both happen
 * client-side, in ./operate.model. */
export function getDoctorReport(profile: string): Promise<DoctorReport> {
  return getJson(`/api/profiles/${encodeURIComponent(profile)}/doctor`);
}

/** POST /api/daemon/stop -> StopDaemonOutcome. Never throws on a non-2xx
 * outcome the server maps to a value (see routes.ts's doc comment for the
 * status-code mapping) — an actual network failure still throws ApiError,
 * same as every other call in this module. */
export function stopDaemon(): Promise<StopDaemonOutcome> {
  return postForOutcome('/api/daemon/stop', STOP_OUTCOMES);
}

/** POST /api/daemon/start -> StartDaemonOutcome. Same non-throwing posture
 * as stopDaemon above, for the 500 spawn_failed outcome. */
export function startDaemon(): Promise<StartDaemonOutcome> {
  return postForOutcome('/api/daemon/start', START_OUTCOMES);
}

/** PUT /api/daemon/autostart, body { enabled } -> AutostartOutcome. */
export function setAutostart(enabled: boolean): Promise<AutostartOutcome> {
  return putJson('/api/daemon/autostart', { enabled });
}

/** The `{date, slot}` pair `ScheduledRunsCard.tsx`'s `nextSlotFor` derives
 * client-side from a profile's `nextRunAt` — `slot` is the next scheduled
 * `HH:MM` to skip, `date` is today's local date. */
export interface SkipNext {
  date: string;
  slot: string;
}

/** Read-modify-write of profile.json's `schedule.skipNext` object, reusing
 * wizard.api's `patchProfileConfig` (same GET-then-PUT of
 * `/api/profiles/:name/config/profile.json` every other profile.json write
 * in this app goes through) rather than duplicating that logic here. */
export async function putSkipNext(profile: string, skipNext: SkipNext): Promise<void> {
  await patchProfileConfig(profile, (cfg) => {
    const schedule = (cfg.schedule as Record<string, unknown> | undefined) ?? {};
    cfg.schedule = { ...schedule, skipNext };
  });
}

/** Read-modify-write of profile.json's `schedule.enabled` flag to the given
 * value, reusing wizard.api's `patchProfileConfig`. `ScheduledRunsCard.tsx`'s
 * per-row pause switch writes through this — the same config PUT
 * `putSkipNext` above uses, per blueprint step 33's "zero new backend
 * surface" instruction. */
export async function setScheduleEnabled(
  profile: string,
  enabled: boolean,
): Promise<void> {
  await patchProfileConfig(profile, (cfg) => {
    const schedule = (cfg.schedule as Record<string, unknown> | undefined) ?? {};
    cfg.schedule = { ...schedule, enabled };
  });
}

/** Read-modify-write of profile.json's `schedule.enabled` flag to false —
 * `usePauseAll.ts`'s one-directional special case of `setScheduleEnabled`
 * above. Calls it once per profile inside a `Promise.allSettled` fan-out —
 * a single profile's rejection here must not affect the sibling calls,
 * which is why this stays a plain async function rather than something
 * that swallows its own errors. */
export async function pauseProfile(profile: string): Promise<void> {
  await setScheduleEnabled(profile, false);
}
