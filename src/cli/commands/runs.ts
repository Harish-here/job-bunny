/**
 * commands/runs.ts (runs-observability Phase 1, Task 12) — `jobbunny
 * runs`: read-only run history straight from the profile's local DB, the
 * CLI successor to the five retired write-only run-artifact files
 * (`result.json`, `run.log`, `heartbeat.json`, `failure.json`,
 * `sync_dryrun.json`).
 *
 * Reuses the board's own composition point (`cli/wire/board.ts`'s
 * `wireBoard`, re-exported by `cli/wire/index.ts`) to open the profile's
 * `BoardStore` — no new adapter, no `src/adapters/**` import here
 * (`only-wire-imports-adapters`). `list` calls `store.listRuns`; for any
 * row whose status is `'failed'` it also calls `store.getRun(id)` to
 * recover `failedStage` out of the row's `result` blob — `RunSummary`
 * itself carries no `failedStage`, only the full `RunResult` does — a
 * handful of extra single-row reads on a local sqlite file at CLI
 * list-page sizes (default 50), never a real cost. `show` reads
 * `getRun` + `listRunEvents` directly, so no extra query there.
 *
 * `result`/`failure` are opaque `unknown` at the port boundary
 * (`ports/run_store.ts`, ledger L12) — narrowed defensively here:
 * `result` via `RunResultSchema.safeParse` (the same schema
 * `cli/commands/run.ts`'s own funnel-line building trusts), `failure` via
 * a hand-rolled shape guard (`RunFailure` has no zod schema of its own —
 * every value that reaches it is produced by our own `recordFailure`
 * callers, never external input). Either narrowing failing (a
 * malformed/absent blob) degrades to omitting that section, never a crash.
 */
import { RunResultSchema } from '../../ops/observability/index.ts';
import type { BoardSource, BoardStore } from '../../ports/board.ts';
import type { RunEventRow, RunFailure, RunSummary } from '../../ports/run_store.ts';
import { wireBoard as defaultWireBoard } from '../wire/index.ts';

export interface RunsCommandOptions {
  profile: string;
  /** Present ⇒ `runs show <runId>`; absent ⇒ `runs` (list). */
  runId?: number;
}

export interface RunsDeps {
  wireBoard: () => BoardSource;
  write: (line: string) => void;
}

function defaultDeps(): RunsDeps {
  return {
    wireBoard: () => defaultWireBoard(),
    write: (line: string) => console.log(line),
  };
}

/** `RunFailure` has no zod schema — it's produced only by our own
 * `recordFailure` callers, never external input — so a hand-rolled shape
 * guard is enough to keep a malformed/absent blob from crashing `show`. */
function isRunFailure(value: unknown): value is RunFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RunFailure>;
  return (
    typeof candidate.stage === 'string' &&
    typeof candidate.error === 'string' &&
    typeof candidate.elapsedMs === 'number'
  );
}

/** Human-readable elapsed time between `startedAt` and `finishedAt` —
 * `undefined` while the run is still open (no `finishedAt` yet) or on a
 * malformed pair; callers render that as the literal `'running'`. */
function formatDuration(
  startedAt: string,
  finishedAt: string | null,
): string | undefined {
  if (finishedAt === null) return undefined;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function failedStageFromResult(result: unknown): string | undefined {
  const parsed = RunResultSchema.safeParse(result);
  return parsed.success ? parsed.data.failedStage : undefined;
}

function summaryLine(row: RunSummary, failedStage: string | undefined): string {
  const duration = formatDuration(row.startedAt, row.finishedAt) ?? 'running';
  return (
    `#${row.id}  ${row.date} ${row.timeDir ?? '-'}  ${row.kind}  ${row.status}  ` +
    `${duration}  ${failedStage ?? ''}`
  );
}

function formatEvent(ev: RunEventRow): string {
  const base = `${ev.ts} ${ev.level} ${ev.msg}`;
  return ev.data === undefined ? base : `${base} ${JSON.stringify(ev.data)}`;
}

function listRuns(store: BoardStore, write: (line: string) => void): void {
  const { rows } = store.listRuns({});
  for (const row of rows) {
    const failedStage =
      row.status === 'failed'
        ? failedStageFromResult(store.getRun(row.id)?.result)
        : undefined;
    write(summaryLine(row, failedStage));
  }
}

function showRun(
  store: BoardStore,
  runId: number,
  write: (line: string) => void,
): number {
  const detail = store.getRun(runId);
  if (!detail) {
    write(`no such run: #${runId}`);
    return 1;
  }

  const parsedResult = RunResultSchema.safeParse(detail.result);
  write(
    summaryLine(detail, parsedResult.success ? parsedResult.data.failedStage : undefined),
  );

  if (isRunFailure(detail.failure)) {
    write('failure:');
    write(`  stage: ${detail.failure.stage}`);
    write(`  error: ${detail.failure.error}`);
    write(`  elapsedMs: ${detail.failure.elapsedMs}`);
    if (detail.failure.lastCheckpoint !== undefined) {
      write(`  lastCheckpoint: ${detail.failure.lastCheckpoint}`);
    }
  }

  if (parsedResult.success) {
    for (const stage of parsedResult.data.stages) {
      write(`  ${stage.name}: ${stage.jobsIn} -> ${stage.jobsOut}`);
    }
  }

  const { rows: events } = store.listRunEvents(runId, {});
  for (const ev of events) write(formatEvent(ev));

  return 0;
}

export async function runsCommand(
  opts: RunsCommandOptions,
  deps: Partial<RunsDeps> = {},
): Promise<number> {
  const resolved: RunsDeps = { ...defaultDeps(), ...deps };
  const source = resolved.wireBoard();
  try {
    const store = await source.openStore(opts.profile);
    if (!store) {
      resolved.write(
        `unknown profile "${opts.profile}" or no local database — nothing to show`,
      );
      return 1;
    }
    if (opts.runId === undefined) {
      listRuns(store, resolved.write);
      return 0;
    }
    return showRun(store, opts.runId, resolved.write);
  } finally {
    source.close();
  }
}
