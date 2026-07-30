import { z } from 'zod';
import type { Logger } from '../../../ports/index.ts';
import { ConsoleLogger, JsonlLogger, LOG_LEVELS } from './loggers.ts';

/** `settings.logging` — validated by `cli/wire/settings.ts`'s
 * `resolveLoggingSettings`, same fail-loud-on-present-but-invalid /
 * default-quietly-on-missing posture as `LinkedinPacingSettingsSchema`.
 * Keys match `JsonlLoggerOptions` (`fileLevel`/`ttyLevel`) to avoid the
 * ambiguous `level` name. `ttyLevel` defaults to 'info' — the one
 * deliberate behavior change this feature makes: debug detail stays in
 * `run.log`, off the interactive terminal by default. */
export const LoggingSettingsSchema = z.object({
  fileLevel: z.enum(LOG_LEVELS).default('debug'),
  ttyLevel: z.enum(LOG_LEVELS).default('info'),
});
export type LoggingConfig = z.infer<typeof LoggingSettingsSchema>;

/** The single creation point commands call instead of `new JsonlLogger(...)`
 * directly. Defaults match `JsonlLogger`'s own class defaults (debug/debug)
 * when `cfg` is absent, so a caller that skips settings resolution entirely
 * still gets today's write-everything/mirror-everything behavior. */
export function createRunLogger(logPath: string, cfg?: LoggingConfig): JsonlLogger {
  return new JsonlLogger(logPath, {
    fileLevel: cfg?.fileLevel ?? 'debug',
    ttyLevel: cfg?.ttyLevel ?? 'debug',
  });
}

/** Replaces `compose.ts`'s silent no-op logger — NDJSON to stderr so
 * wire-time diagnostics (e.g. a notifier construction failure) are never
 * dropped. Defaults to `ttyLevel: 'info'`, matching the settings schema's
 * own default. */
export function createWireLogger(cfg?: Pick<LoggingConfig, 'ttyLevel'>): Logger {
  return new ConsoleLogger({ level: cfg?.ttyLevel ?? 'info' });
}

/** Daemon events as `{ts,level,msg,data}` on STDOUT — lands in `daemon.log`
 * via the parent's existing fd redirect; the daemon's own spawn/rotate
 * mechanism is untouched by this factory. */
export function createDaemonLogger(): Logger {
  return new ConsoleLogger({ write: (line) => console.log(line) });
}
