/**
 * Pure JSON encode/decode helpers for the `runs.catchup_slots_json` column
 * (persist-to-db Phase 1, step 1.5) — kept OUT of `store.ts` as this
 * subfolder's second module, since `store.ts` is already at the file-size
 * cap on its own (see its own header comment); mirrors why `runs/
 * progress.ts` was split out of `runs/store.ts` in the first place.
 */
export function encodeCatchupSlots(catchupSlots: string[] | undefined): string | null {
  return catchupSlots === undefined ? null : JSON.stringify(catchupSlots);
}

export function decodeCatchupSlots(json: string | null): string[] | null {
  return json === null ? null : (JSON.parse(json) as string[]);
}
