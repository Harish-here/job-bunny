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
  BoardProfile,
  ProfilesResponse,
} from '../../../../src/app/features/profiles/index.ts';
