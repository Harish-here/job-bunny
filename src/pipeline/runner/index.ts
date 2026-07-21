// P3 handoff contract — everything a caller needs to wire and run a
// pipeline: stage types, context types, storage, and the runner itself.
// `guardStage` is intentionally internal (see guard.ts) and not exported.

export type { PipelineCtx, WiredPorts } from './context.ts';
export { FsStorage } from './fs_storage.ts';
export type { RunnerOptions } from './run.ts';
export { runPipeline } from './run.ts';
export type { DroppedRecord, StageContext, StageDef, StagePayload } from './stage.ts';
