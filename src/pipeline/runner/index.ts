// P3 handoff contract — everything a caller needs to wire and run a
// pipeline: stage types, context types, storage, and the runner itself.
// `guardStage` is not re-exported here (see guard.ts) — it is runner
// internals, not part of the runner's public surface. The one deliberate
// exception is `cli/commands/stage.ts`, which imports guard.ts directly so a
// single-stage run gets the SAME timeout/retry/stall semantics runPipeline
// applies, rather than reimplementing them.

export type { PipelineCtx, WiredPorts } from './context.ts';
export { FsStorage } from './fs_storage.ts';
export type { RunnerOptions } from './run.ts';
export { runPipeline } from './run.ts';
export type { DroppedRecord, StageContext, StageDef, StagePayload } from './stage.ts';
