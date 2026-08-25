/**
 * Fetching section's pure pacing-preset model (blueprint.md:830-846, step
 * 20). `presetFromRanges`/`rangesFromPreset` are the two-way mapping
 * between `profile.json`'s `settings.linkedin` raw ms pair and the
 * three-preset UI (`FetchingSection`/`PacingPresetCard`, step 19).
 *
 * This is UI code — it cannot import `src/core/config/linkedin_pacing/
 * index.ts` at runtime (that module is not one of the two dependency-free
 * `src/core/**` modules `ui/` is allowed to import; see CLAUDE.md and this
 * brief's GLOBAL CONSTRAINTS). The Normal preset's values below are copied
 * from that module's own `DEFAULT_JITTER_MIN_MS`/`DEFAULT_JITTER_MAX_MS`/
 * `DEFAULT_INTER_URL_DELAY_MIN_MS`/`DEFAULT_INTER_URL_DELAY_MAX_MS`
 * constants as reference numbers (5000/12000/20000/45000 — today's shipped
 * default), and Safe/Fast are cross-checked against
 * `docs/product/settings-overhaul/ux-notes.md` §7's preset table
 * (`8–18s`/`35–70s` for Safe, `2–5s`/`8–15s` for Fast), converted to ms.
 * Every value here is a plain local constant, not a re-import.
 */

export type PacingPresetName = 'safe' | 'normal' | 'fast';
export type PacingPresetOrCustom = PacingPresetName | 'custom';

export interface PacingRanges {
  jitterMinMs: number;
  jitterMaxMs: number;
  interUrlDelayMinMs: number;
  interUrlDelayMaxMs: number;
}

const PRESET_RANGES: Record<PacingPresetName, PacingRanges> = {
  // ux-notes §7: "8–18s between pages · 35–70s between searches".
  safe: {
    jitterMinMs: 8_000,
    jitterMaxMs: 18_000,
    interUrlDelayMinMs: 35_000,
    interUrlDelayMaxMs: 70_000,
  },
  // Matches `core/config/linkedin_pacing/index.ts`'s shipped defaults —
  // Normal is today's active default (D2/D3, 2026-07-28).
  normal: {
    jitterMinMs: 5_000,
    jitterMaxMs: 12_000,
    interUrlDelayMinMs: 20_000,
    interUrlDelayMaxMs: 45_000,
  },
  // ux-notes §7: "2–5s between pages · 8–15s between searches".
  fast: {
    jitterMinMs: 2_000,
    jitterMaxMs: 5_000,
    interUrlDelayMinMs: 8_000,
    interUrlDelayMaxMs: 15_000,
  },
};

/** The preset whose exact ms values match all four inputs, or `'custom'`
 * when none match — e.g. any raw-field hand-edit that doesn't happen to
 * land on a named preset's exact numbers. */
export function presetFromRanges(
  jitterMin: number,
  jitterMax: number,
  interUrlMin: number,
  interUrlMax: number,
): PacingPresetOrCustom {
  for (const preset of Object.keys(PRESET_RANGES) as PacingPresetName[]) {
    const ranges = PRESET_RANGES[preset];
    if (
      ranges.jitterMinMs === jitterMin &&
      ranges.jitterMaxMs === jitterMax &&
      ranges.interUrlDelayMinMs === interUrlMin &&
      ranges.interUrlDelayMaxMs === interUrlMax
    ) {
      return preset;
    }
  }
  return 'custom';
}

/** The inverse of `presetFromRanges` for a named preset — `'custom'` has
 * no inverse (there is no single ms quadruple to return to). */
export function rangesFromPreset(preset: PacingPresetName): PacingRanges {
  return PRESET_RANGES[preset];
}
