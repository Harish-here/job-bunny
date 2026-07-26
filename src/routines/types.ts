import type { PipelineCtx } from '../pipeline/runner/index.ts';

/**
 * Routine (P7 Task 5; spec §3 "Routines are first-class recurring
 * maintenance"): a named piece of maintenance work the runner can invoke at
 * a declared point, independent of the job-flow `StageDef` pipeline.
 * Frozen shape — do not widen it:
 *   - `when: 'pre-run'`    — before the job-flow stages start (not yet
 *                            wired into the runner; a future phase's job).
 *   - `when: 'post-sync'`  — after the `sync` stage, once jobs are durably
 *                            in the connector DB (e.g. `cleanup`).
 *   - `when: 'standalone'` — invoked directly (e.g. `jobbunny routine
 *                            <name>`), never as part of a `/run`.
 * `run(ctx: PipelineCtx)` — unlike a `StageDef`, a `Routine` DOES receive
 * the full `PipelineCtx` (config + ports + notify), not the narrower
 * `StageContext` a job-flow stage gets — a routine's whole job is often to
 * reach a port (e.g. `ctx.ports.connector`) and/or `ctx.config`, so there is
 * no equivalent need to inject dependencies via a factory the way
 * `pipeline/stages/*.ts`'s `make*Stage` functions do.
 */
export interface Routine {
  name: string;
  when: 'pre-run' | 'post-sync' | 'standalone';
  run(ctx: PipelineCtx): Promise<void>;
}
