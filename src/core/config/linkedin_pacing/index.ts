/**
 * core/config/linkedin_pacing/index.ts — the LinkedIn lane's pacing tunable
 * (throttle guard D2/D3, 2026-07-28), relocated out of `cli/wire/settings.ts`
 * (BE-gate finding F8/F14, blueprint-be.md §3.1) so `core/config/
 * validators.ts` can validate it at config-save time, not just at wire time.
 * lives in `core/` rather than inside the LinkedIn adapter because
 * `core/config/validators.ts` must reach it at save time and `core-is-pure`
 * forbids the reverse import — see blueprint-be.md §3.1
 */
import { z } from 'zod';

/** Live pacing defaults for the linkedin lane (throttle guard D2/D3,
 * 2026-07-28). Raised from the old v0-parity (2000, 5000) after LinkedIn
 * soft-throttled the shared `.chrome-debug` session under that cadence: 21
 * saved-search urls x 5 fires/day at ~1 navigation per 12s read as a burst.
 * Kept here (not just in the lane) so a profile with no `settings.linkedin`
 * pacing keys at all still gets a fully-populated, schema-validated range —
 * the lane's own defaults stay a no-op `(0, 0)` for tests. */
export const DEFAULT_JITTER_MIN_MS = 5_000;
export const DEFAULT_JITTER_MAX_MS = 12_000;

/** Pause between saved-search urls (D2). Together with the jitter above
 * this puts a 21-url fire at roughly 25 minutes against farm's unchanged
 * 90-minute ceiling — deliberately the moderate tier, since the
 * conservative one (~50 min) would eventually force raising that ceiling. */
export const DEFAULT_INTER_URL_DELAY_MIN_MS = 20_000;
export const DEFAULT_INTER_URL_DELAY_MAX_MS = 45_000;

/** Unlike `resolveMaxCardsPerUrl`/`resolveInventoryMaxAgeDays` (silently
 * fall back to a default on any bad value), an operator-set pacing range
 * that doesn't make sense (min > max, or either negative) is a
 * config-authoring mistake, not "value absent" — fail LOUD (zod throws),
 * same posture as `NotionConnectorSettingsSchema.parse`/
 * `TelegramNotifierSettingsSchema.parse`. Missing keys still default
 * quietly, only a present-but-invalid value throws.
 *
 * Both pacing pairs share one schema (D3): they are read from the same
 * `settings.linkedin` blob and validated together, so a profile cannot end
 * up with a valid inter-url range sitting next to an inverted jitter one.
 *
 * One-sided overrides interact with the defaults, and the 2026-07-28 raise
 * (jitter 2000/5000 -> 5000/12000) made that sharper: a profile that sets
 * ONLY `jitterMaxMs` below 5000 now inverts the range against the default
 * `jitterMinMs` and throws here — failing `run` AND `doctor` — so such a
 * profile must set `jitterMinMs` too. Same shape for an
 * `interUrlDelayMaxMs` set alone below the 20000 default. */
export const LinkedinPacingSettingsSchema = z
  .object({
    jitterMinMs: z.number().min(0).default(DEFAULT_JITTER_MIN_MS),
    jitterMaxMs: z.number().min(0).default(DEFAULT_JITTER_MAX_MS),
    interUrlDelayMinMs: z.number().min(0).default(DEFAULT_INTER_URL_DELAY_MIN_MS),
    interUrlDelayMaxMs: z.number().min(0).default(DEFAULT_INTER_URL_DELAY_MAX_MS),
  })
  .refine((v) => v.jitterMinMs <= v.jitterMaxMs, {
    message: 'settings.linkedin.jitterMinMs must be <= settings.linkedin.jitterMaxMs',
  })
  .refine((v) => v.interUrlDelayMinMs <= v.interUrlDelayMaxMs, {
    message:
      'settings.linkedin.interUrlDelayMinMs must be <= settings.linkedin.interUrlDelayMaxMs',
  });
