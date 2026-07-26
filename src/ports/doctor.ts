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

/** Aggregate result of running a set of DoctorChecks (ops/doctor/aggregate.ts,
 * P8): `status` is the worst finding (red > warn > ok), findings preserve
 * input order. */
export interface DoctorReport {
  findings: DoctorFinding[];
  status: DoctorStatus;
}
