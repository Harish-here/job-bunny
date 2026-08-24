import { getJson, postJson, putJson } from '../../lib/api/client';
import type {
  AutostartOutcome,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../lib/api/types';
import { patchProfileConfig } from '../wizard/wizard.api';

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
  return postJson('/api/daemon/stop', {});
}

/** POST /api/daemon/start -> StartDaemonOutcome. */
export function startDaemon(): Promise<StartDaemonOutcome> {
  return postJson('/api/daemon/start', {});
}

/** PUT /api/daemon/autostart, body { enabled } -> AutostartOutcome. */
export function setAutostart(enabled: boolean): Promise<AutostartOutcome> {
  return putJson('/api/daemon/autostart', { enabled });
}

/** Read-modify-write of profile.json's `schedule.skipNext` flag, reusing
 * wizard.api's `patchProfileConfig` (same GET-then-PUT of
 * `/api/profiles/:name/config/profile.json` every other profile.json write
 * in this app goes through) rather than duplicating that logic here. */
export async function putSkipNext(profile: string, skipNext: boolean): Promise<void> {
  await patchProfileConfig(profile, (cfg) => {
    const schedule = (cfg.schedule as Record<string, unknown> | undefined) ?? {};
    cfg.schedule = { ...schedule, skipNext };
  });
}
