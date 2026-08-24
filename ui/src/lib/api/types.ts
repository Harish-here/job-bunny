/**
 * The UI's single import point for backend contract types. Type-only —
 * `verbatimModuleSyntax` guarantees these erase at compile time, so no
 * `src/` code is ever bundled into the frontend.
 */
export type {
  BoardDetailResponse,
  BoardJobDetail,
  BoardJobRow,
  BoardListResponse,
  BoardMetaResponse,
  ListQuery,
  TrackingPatchBody,
  TrackingPatchResponse,
  TrackingRow,
} from '../../../../src/app/features/board/index.ts';
export type {
  ConfigGetResponse,
  CreateProfileResponse,
} from '../../../../src/app/features/config/index.ts';
export type {
  AutostartOutcome,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../../../src/app/features/daemon/index.ts';
export type { FilterPreviewResult } from '../../../../src/app/features/preview/index.ts';
export type {
  BoardProfile,
  ProfilesResponse,
} from '../../../../src/app/features/profiles/index.ts';
export type {
  DeferredSlotRow,
  GetRunResponse,
  GetSoftErrorsResponse,
  ListDeferredSlotsResponse,
  ListRunEventsResponse,
  ListRunsResponse,
  RunDetail,
  RunEventRow,
  RunProgress,
  RunSummary,
  SoftErrorGroup,
  SoftErrorSummary,
} from '../../../../src/app/features/runs/index.ts';
export type {
  SecretKey,
  SecretPresence,
} from '../../../../src/app/features/secrets/index.ts';
