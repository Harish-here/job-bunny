/**
 * ports/board_preview.ts (fix round — misattributed-error finding) — the
 * ONE error type `BoardSource.previewFilterRule` throws to mean "the
 * caller's DRAFT filter config itself fails schema validation" (the route
 * layer maps this, and only this, to HTTP 422). Its real implementation
 * lives in `cli/wire/board_preview.ts`, but `app` may not import `cli`
 * (`nothing-imports-cli`/`only-cli-imports-app`), so that file can't be the
 * shared home for a type both it and `app/features/preview/routes.ts` need
 * — this pure port module is, mirroring `board_daemon.ts`'s own precedent
 * for a small dedicated port file split out of `board.ts`'s orbit.
 *
 * Any OTHER throw from `previewFilterRule` — the profile's own stored
 * `filter.json` failing `JSON.parse` or schema validation, or
 * `BoardSource.openStore` throwing on a corrupt/schema-newer db — is
 * DELIBERATELY NOT an instance of this class. Conflating the two
 * misattributes a server-side data problem as the caller's input error
 * (see `cli/wire/board_preview.ts`'s own doc comment for exactly where
 * each throw happens).
 */
export class InvalidDraftFilterConfigError extends Error {
  override readonly name = 'InvalidDraftFilterConfigError';
}

export function isInvalidDraftFilterConfigError(
  err: unknown,
): err is InvalidDraftFilterConfigError {
  return err instanceof InvalidDraftFilterConfigError;
}
