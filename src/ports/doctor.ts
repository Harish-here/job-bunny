export type DoctorStatus = 'ok' | 'warn' | 'red';

export interface DoctorFinding {
  check: string;
  status: DoctorStatus;
  detail: string;
}

/** Contributed by adapters/modules; aggregated by ops/doctor (P8).
 * red aborts a run before it starts. */
export interface DoctorCheck {
  name: string;
  run(): Promise<DoctorFinding>;
}
