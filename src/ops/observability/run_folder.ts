import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunResult } from './result.ts';

const CHECKPOINT_RE = /^(\d{2})-(.+)\.json$/;

/** One run's observability artifacts: checkpoints, heartbeat, failure and
 * result records, and the log file — rooted at
 * `<profileDataDir>/runs/<date>/`. All writes are atomic (temp + rename)
 * so a killed process never leaves a truncated file. */
export class RunFolder {
  readonly dir: string;

  constructor(profileDataDir: string, date: string) {
    this.dir = join(profileDataDir, 'runs', date);
  }

  checkpointPath(index: number, stage: string): string {
    return join(this.dir, `${String(index).padStart(2, '0')}-${stage}.json`);
  }

  async writeCheckpoint(index: number, stage: string, payload: unknown): Promise<void> {
    await this.writeAtomic(this.checkpointPath(index, stage), payload);
  }

  async readLatestCheckpoint(): Promise<
    { index: number; stage: string; payload: unknown } | undefined
  > {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }

    let best: { index: number; stage: string; file: string } | undefined;
    for (const entry of entries) {
      const match = CHECKPOINT_RE.exec(entry);
      if (!match) continue;
      const index = Number(match[1]);
      const stage = match[2] as string;
      // Ties (same index, different stage) should never happen in normal
      // operation — the runner assigns one index per stage in sequence.
      // On a tie we keep the first one encountered (readdir order).
      if (!best || index > best.index) best = { index, stage, file: entry };
    }
    if (!best) return undefined;

    const raw = await readFile(join(this.dir, best.file), 'utf8');
    return { index: best.index, stage: best.stage, payload: JSON.parse(raw) };
  }

  async writeHeartbeat(stage: string): Promise<void> {
    await this.writeAtomic(join(this.dir, 'heartbeat.json'), {
      stage,
      at: new Date().toISOString(),
    });
  }

  async writeFailure(f: {
    stage: string;
    error: string;
    elapsedMs: number;
    lastCheckpoint?: string;
  }): Promise<void> {
    await this.writeAtomic(join(this.dir, 'failure.json'), f);
  }

  async writeResult(r: RunResult): Promise<void> {
    await this.writeAtomic(join(this.dir, 'result.json'), r);
  }

  logPath(): string {
    return join(this.dir, 'run.log');
  }

  private async writeAtomic(absPath: string, value: unknown): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmpPath, absPath);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
