export type { RunDurationEstimate } from '../../../ports/board.ts';
export { MIN_DURATION_SAMPLE_SIZE } from '../../../ports/board.ts';
export type { DeferredSlotRow } from '../../../ports/deferred_slots.ts';
export type {
  RunDetail,
  RunEventRow,
  RunProgress,
  RunSummary,
} from '../../../ports/run_store.ts';
export type {
  GetRunResponse, // RunDetailResponse
  GetSoftErrorsResponse, // SoftErrorSummary
  ListDeferredSlotsResponse, // { rows: DeferredSlotRow[]; total: number; date: string }
  ListRunEventsResponse, // { rows: RunEventRow[]; total: number; limit: number; offset: number }
  ListRunsResponse, // { rows: RunListRow[]; total: number; limit: number; offset: number }
  RunDetailResponse, // RunDetail + estimatedDurationMs: number | null (populated only when status === 'running')
  RunListRow, // RunSummary + softErrors: SoftErrorSummary (health-gate inputs, no per-row fetch)
} from './routes.ts';
export { makeRunsRoutes } from './routes.ts';
export type { SoftErrorGroup, SoftErrorSummary } from './soft_errors.ts';
