import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogData, Logger } from '../../ports/index.ts';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Logger implementation writing newline-delimited JSON to a run's
 * `run.log`; mirrors to stdout only when attached to a TTY (headless
 * launchd runs stay quiet, interactive `/run` stays readable). */
export class JsonlLogger implements Logger {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
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
    if (process.stdout.isTTY) {
      console.log(line);
    }
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
