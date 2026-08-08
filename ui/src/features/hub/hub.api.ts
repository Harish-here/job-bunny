import { getJson } from '../../lib/api/client';

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
 * client-side, in ./hub.model. */
export function getDoctorReport(profile: string): Promise<DoctorReport> {
  return getJson(`/api/profiles/${encodeURIComponent(profile)}/doctor`);
}
