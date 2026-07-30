import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogData, Logger } from '../../../ports/index.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** True when `level` is at or above `threshold` in `LOG_LEVELS` order. */
export function shouldLog(threshold: LogLevel, level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}

export interface JsonlLoggerOptions {
  /** File-sink threshold. Default 'debug' — today's write-everything behavior. */
  fileLevel?: LogLevel;
  /** TTY-mirror threshold. Default 'debug' — today's mirror-everything behavior.
   *  (The 'info' default from settings.logging is applied by the SETTINGS layer,
   *  not here, so the class alone is byte-compatible with current behavior.) */
  ttyLevel?: LogLevel;
  /** Injectable for tests. Default: () => Boolean(process.stdout.isTTY). Evaluated
   *  PER log() call, never captured at construction — isTTY can flip mid-run. */
  isTTY?: () => boolean;
}

/** Logger implementation writing newline-delimited JSON to a run's
 * `run.log`; mirrors to stdout only when attached to a TTY (headless
 * daemon runs stay quiet, interactive `/run` stays readable). */
export class JsonlLogger implements Logger {
  readonly filePath: string;
  private readonly fileLevel: LogLevel;
  private readonly ttyLevel: LogLevel;
  private readonly isTTY: () => boolean;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, opts: JsonlLoggerOptions = {}) {
    this.filePath = filePath;
    this.fileLevel = opts.fileLevel ?? 'debug';
    this.ttyLevel = opts.ttyLevel ?? 'debug';
    this.isTTY = opts.isTTY ?? (() => Boolean(process.stdout.isTTY));
  }

  debug(msg: string, data?: LogData): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: LogData): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: LogData): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: LogData): void {
    this.log('error', msg, data);
  }

  /** Resolves once every write queued so far has landed on disk — for
   * callers (and tests) that need durability before exiting. Not part of
   * the Logger port; a JsonlLogger-specific convenience. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private log(level: LogLevel, msg: string, data?: LogData): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, data });
    if (shouldLog(this.ttyLevel, level) && this.isTTY()) {
      console.log(line);
    }
    if (!shouldLog(this.fileLevel, level)) return;
    this.queue = this.queue
      .then(() => this.append(line))
      .catch((err: unknown) => {
        // Logging must never crash the pipeline — surface failures on stderr.
        console.error('JsonlLogger write failed:', err);
      });
  }

  private async append(line: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${line}\n`, 'utf8');
  }
}

export interface ConsoleLoggerOptions {
  /** Threshold below which lines are dropped entirely. Default 'debug'. */
  level?: LogLevel;
  /** Default: (line) => console.error(line) — stderr. */
  write?: (line: string) => void;
}

/** NDJSON {ts,level,msg,data} to a stream — the wire placeholder (stderr)
 *  and the daemon event emitter (stdout, via the existing fd redirect). */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly write: (line: string) => void;

  constructor(opts: ConsoleLoggerOptions = {}) {
    this.level = opts.level ?? 'debug';
    this.write = opts.write ?? ((line) => console.error(line));
  }

  debug(msg: string, data?: LogData): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: LogData): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: LogData): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: LogData): void {
    this.log('error', msg, data);
  }

  private log(level: LogLevel, msg: string, data?: LogData): void {
    if (!shouldLog(this.level, level)) return;
    this.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, data }));
  }
}

/** Logger-implementing wrapper: merges { scope } into every line's data.
 *  Nesting composes with '.' and delegates straight to the innermost base —
 *  withScope(withScope(l,'farm'),'linkedin') emits data.scope === 'farm.linkedin'
 *  and calls l directly, never double-wrapping. No port change — it IS a Logger. */
class ScopedLogger implements Logger {
  readonly scope: string;
  private readonly base: Logger;

  private constructor(base: Logger, scope: string) {
    this.base = base;
    this.scope = scope;
  }

  /** Composes with the innermost base when `base` is itself a ScopedLogger —
   *  a static method (unlike a free function) can reach another instance's
   *  private `base` field, since TS privacy is scoped to the class body. */
  static wrap(base: Logger, scope: string): Logger {
    if (base instanceof ScopedLogger) {
      return new ScopedLogger(base.base, `${base.scope}.${scope}`);
    }
    return new ScopedLogger(base, scope);
  }

  debug(msg: string, data?: LogData): void {
    this.base.debug(msg, { ...data, scope: this.scope });
  }

  info(msg: string, data?: LogData): void {
    this.base.info(msg, { ...data, scope: this.scope });
  }

  warn(msg: string, data?: LogData): void {
    this.base.warn(msg, { ...data, scope: this.scope });
  }

  error(msg: string, data?: LogData): void {
    this.base.error(msg, { ...data, scope: this.scope });
  }
}

export function withScope(base: Logger, scope: string): Logger {
  return ScopedLogger.wrap(base, scope);
}
