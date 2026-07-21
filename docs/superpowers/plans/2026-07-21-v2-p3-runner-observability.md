# v2 P3 — Runner + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.
> **Depends on:** P1 merged (ports, errors, core/config). P2 not required — the runner is tested with fake stages.

**Goal:** The one pipeline process: generic `StageDef` runner with checkpoints, three-layer watchdog, run folder observability, funnel-bearing `result.json`, and the `Storage`/doctor scaffolding later phases plug into.

**Architecture:** Spec §7. Everything here is adapter-agnostic: the runner sees only `WiredPorts` interfaces; fake in-memory stages/ports drive every test. No browser, no network, no LLM in this phase.

## Global Constraints

- Branch `feat/v2-p3-runner` off `main-v2`; PR into `main-v2`. All P1 constraints apply.
- `AbortSignal.timeout()` / `AbortSignal.any()` only — no hand-rolled setTimeout deadline logic outside the stall watchdog.
- A thrown `SoftError` **escaping a stage** is still a stage failure — SoftError is for per-item handling *inside* stages (caught, recorded, continue); the runner treats any escape as loud.
- Checkpoint writes are atomic (write temp + rename) — a killed process never leaves a truncated checkpoint.

## File Structure

```
src/ports/doctor.ts                      new port: DoctorCheck (port-extension task)
src/pipeline/runner/
  stage.ts + stage.test.ts               StageDef, StageContext, StagePayload, DroppedRecord
  context.ts                             PipelineCtx, WiredPorts (types only)
  guard.ts + guard.test.ts               timeout + heartbeat-stall + retry wrapper
  run.ts + run.test.ts                   runPipeline: compose, checkpoint, resume, failure capture
  fs_storage.ts + fs_storage.test.ts     Storage impl rooted at profile data dir
  index.ts
src/ops/observability/
  run_folder.ts + run_folder.test.ts     paths + atomic writes: checkpoints, heartbeat, failure
  logger.ts + logger.test.ts             JsonlLogger (file) + console mirror
  result.ts + result.test.ts             RunResultSchema + funnel builder
  index.ts
```

---

### Task 1: Port extension — `ports/doctor.ts`

**Interfaces — Produces (frozen):**

```ts
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
```

- [ ] Steps: add file + re-export from `ports/index.ts` → `npm run check` → commit `feat(v2): DoctorCheck port`.

---

### Task 2: Stage + context types, `StagePayload`

**Interfaces — Produces (frozen — every later stage conforms):**

```ts
// stage.ts
import type { JD, Verdict } from '../../core/jd/index.ts';
import type { RunContext, Storage } from '../../ports/index.ts';

export interface DroppedRecord { jd: JD; reasons: Verdict[] }

/** Standard payload flowing between job-flow stages. Dropped records ride
 * along so the funnel and checkpoints can always answer "why did this
 * job disappear?" (spec §4). */
export interface StagePayload { jobs: JD[]; dropped: DroppedRecord[] }

export interface StageContext extends RunContext { storage: Storage }

export interface StageDef<In, Out> {
  name: string;
  timeoutMs: number;
  retries: number;              // 0 for most; structure/sync 1–2
  heartbeat?: boolean;          // declared ⇒ stall watchdog armed
  run(input: In, ctx: StageContext): Promise<Out>;
}
```

```ts
// context.ts
import type { PipelineConfig } from '../../core/config/index.ts';
import type {
  BrowserProvider, Connector, Lane, LlmProvider, Notifier, NotifyEvent,
} from '../../ports/index.ts';
import type { StageContext } from './stage.ts';

export interface WiredPorts {
  lanes: Lane[];
  connector: Connector;
  notifiers: Notifier[];
  llm?: LlmProvider;
  browser?: BrowserProvider;
}

export interface PipelineCtx extends StageContext {
  config: PipelineConfig;
  ports: WiredPorts;
  notify(event: NotifyEvent): Promise<void>;   // fans out to all notifiers
}
```

- [ ] Steps: TDD a tiny type-exercise test (a fake `StageDef<StagePayload, StagePayload>` that drops one job with a verdict and runs under a fake ctx) → implement → `npm run check` → commit `feat(v2): StageDef/StagePayload/PipelineCtx contracts`.

---

### Task 3: `FsStorage`

**Interfaces:** Produces `FsStorage implements Storage` — ctor `new FsStorage(rootDir: string)`; `readJson` returns `undefined` on ENOENT, throws `ZodError` on shape mismatch; `writeJson` creates parent dirs, writes atomically (`<file>.tmp` + `rename`), pretty-prints (git-diffable per spec §2 sqlite rejection).

- [ ] Steps: failing tests (round-trip; missing file undefined; schema mismatch throws; nested relPath creates dirs; tmp file never left behind) → implement with `node:fs/promises` → pass → commit `feat(v2): FsStorage`.

---

### Task 4: Run folder + logger + result schema

**Interfaces — Produces:**

```ts
// run_folder.ts — profiles/<p>/data/runs/<YYYY-MM-DD>/
export class RunFolder {
  constructor(profileDataDir: string, date: string);
  checkpointPath(index: number, stage: string): string;   // NN-<stage>.json
  writeCheckpoint(index: number, stage: string, payload: unknown): Promise<void>;
  readLatestCheckpoint(): Promise<{ index: number; stage: string; payload: unknown } | undefined>;
  writeHeartbeat(stage: string): Promise<void>;           // heartbeat.json {stage, at}
  writeFailure(f: { stage: string; error: string; elapsedMs: number; lastCheckpoint?: string }): Promise<void>;
  writeResult(r: RunResult): Promise<void>;
  logPath(): string;                                      // run.log
}
```

```ts
// result.ts
export const RunResultSchema = z.object({
  profile: z.string(),
  date: z.string(),
  outcome: z.enum(['passed', 'failed']),
  failedStage: z.string().optional(),
  stages: z.array(z.object({
    name: z.string(), elapsedMs: z.number(), attempts: z.number(),
    jobsIn: z.number(), jobsOut: z.number(),
    dropsByRule: z.record(z.string(), z.number()),        // the funnel
  })),
});
export type RunResult = z.infer<typeof RunResultSchema>;
export function buildFunnel(payloadIn: StagePayload, payloadOut: StagePayload): { jobsIn: number; jobsOut: number; dropsByRule: Record<string, number> };
```

`JsonlLogger implements Logger` — appends `{ts, level, msg, data}` JSON lines to `run.log`; mirrors to stdout when `process.stdout.isTTY`.

- [ ] Steps: TDD each file (checkpoint naming `01-farm.json`; latest-checkpoint resolution; funnel counts drops grouped by first failing verdict rule) → implement → pass → commit `feat(v2): run folder, jsonl logger, result+funnel`.

---

### Task 5: Guard — timeout, stall, retry

**Interfaces:** Produces `guardStage<In,Out>(stage: StageDef<In,Out>, input: In, ctx: PipelineCtx, opts: { stallMs: number }): Promise<Out>`:

- Wraps `stage.run` with `AbortSignal.any([ctx.signal, AbortSignal.timeout(stage.timeoutMs)])` threaded into a per-attempt child ctx.
- If `stage.heartbeat`, a stall timer rejects when no `beat()` for `opts.stallMs` (each `beat()` resets it and refreshes `heartbeat.json`).
- On failure: retry up to `stage.retries` with fresh signal per attempt; final failure rethrows original error tagged with attempt count.

- [ ] Steps: failing tests with fake timers/stages — (a) slow stage killed at timeoutMs; (b) heartbeat stage that beats survives past stallMs, one that stops beating is killed; (c) fails-once stage succeeds on retry, attempts reported; (d) run-level `ctx.signal` abort cancels immediately → implement → pass → commit `feat(v2): stage guard (timeout/stall/retry)`.

---

### Task 6: `runPipeline`

**Interfaces — Produces (frozen):**

```ts
export interface RunnerOptions {
  runCapMs: number;             // global cap — third watchdog layer
  stallMs: number;
  resume: boolean;              // same-day: skip stages ≤ latest checkpoint
}

export function runPipeline(
  stages: Array<StageDef<StagePayload, StagePayload>>,
  ctx: PipelineCtx,
  folder: RunFolder,
  opts: RunnerOptions,
): Promise<RunResult>;
```

Behavior: sequential; global `AbortSignal.timeout(runCapMs)` composed into ctx; after each stage `writeCheckpoint(i, name, payload)`; on resume, fast-forward from `readLatestCheckpoint()`; on stage failure `writeFailure` + `writeResult(outcome:'failed')` and **still return** the RunResult (caller decides exit code); on success `writeResult(outcome:'passed')`. The runner sends nothing to notifiers itself — digest sending is wired in P8's run command from the returned RunResult (single-sender invariant lives one level up).

- [ ] Steps: failing tests with 3 fake stages — happy path (3 checkpoints, funnel populated, passed); mid-failure (failure.json, result failed, later stages not run); resume skips completed stages and reuses checkpoint payload; run-cap abort marks failure → implement → pass → `npm run check` → commit `feat(v2): runPipeline — checkpoints, resume, failure capture`.

---

### Task 7: Rajni fixture verify + docs

- [ ] Wire a **throwaway** verify script (scratch, not committed) composing runPipeline with 2 fake stages against `profiles/rajni/data/` paths; confirm the run folder artifacts appear and `result.json` validates against `RunResultSchema`.
- [ ] Update `main-v2.md` Phase status (P3 ✅ — note: P4/P5/P6 now unblocked, P5∥P6 parallelizable). PR into `main-v2`.
