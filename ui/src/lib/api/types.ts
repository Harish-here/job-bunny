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
  BoardProfile,
  ProfilesResponse,
} from '../../../../src/app/features/profiles/index.ts';
export type {
  GetRunResponse,
  ListRunEventsResponse,
  ListRunsResponse,
  RunDetail,
  RunEventRow,
  RunSummary,
} from '../../../../src/app/features/runs/index.ts';
