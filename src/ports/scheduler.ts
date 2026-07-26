export interface ScheduledJob {
  profile: string;
  /** HH:MM, 24h, machine-local time. */
  time: string;
}

export interface Scheduler {
  readonly name: string;
  install(jobs: ScheduledJob[]): Promise<void>;
  remove(profile: string): Promise<void>;
  list(): Promise<ScheduledJob[]>;
}
