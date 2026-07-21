/**
 * Minimal execution context adapters receive. The full pipeline ctx (P3)
 * extends this — ports must never depend on pipeline/.
 */
export type LogData = Record<string, unknown>;

export interface Logger {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
}

export interface RunContext {
  profile: string;
  /** Deadline/cancellation — every network/CDP call must honor it. */
  signal: AbortSignal;
  logger: Logger;
  /** Heartbeat tick — long operations must call this (watchdog, spec §7). */
  beat(): void;
}
