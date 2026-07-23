import { z } from 'zod';
import type { Routine } from '../types.ts';

/**
 * cleanup routine (P7 Task 5) — archives stale Notion rows via
 * `ctx.ports.connector.archiveStale`, whose exact staleness rules live in
 * `adapters/db/notion/archive.ts` (ported from v0 `scripts/notion/
 * cleanup.js`): Status=Passed pages older than `passedOlderThanDays`, and
 * pages with NO Status at all (never triaged — `syncJobs` never writes
 * Status) older than `untouchedOlderThanDays`.
 *
 * Settings come from the pipeline config's `settings.cleanup` slice
 * (`PipelineConfigSchema.settings` is an untyped `Record<string, unknown>`
 * — each routine/adapter owns and validates its own key). A `Routine` is a
 * plain object, not a class with a constructor, so — unlike
 * `NotionConnector`'s settings, validated once at construction — this
 * validates on every `run()` instead ("at first use", per the task). An
 * absent `settings.cleanup` key parses to the pinned v0 defaults, not an
 * error: `passedOlderThanDays: 7`, `untouchedOlderThanDays: 30` (v0
 * `cleanup.js`'s own `DAYS_OLD`/`LEAD_DAYS_OLD` env-var defaults).
 *
 * Dry-run is deliberately NOT modeled here: it belongs entirely to the
 * connector's own settings (`NotionConnectorSettings.dryRun`, defaulting to
 * `true` — v0's `--apply`/`CLEANUP_APPLY` opt-in invariant). This routine
 * always calls `archiveStale`; whether that call actually writes anything
 * is a decision owned by the connector and never overridden here.
 */
export const CleanupSettingsSchema = z.object({
  /** v0 `cleanup.js` `DAYS_OLD` default. */
  passedOlderThanDays: z.number().int().min(0).default(7),
  /** v0 `cleanup.js` `LEAD_DAYS_OLD` default. */
  untouchedOlderThanDays: z.number().int().min(0).default(30),
});

export type CleanupSettings = z.infer<typeof CleanupSettingsSchema>;

export const cleanupRoutine: Routine = {
  name: 'cleanup',
  when: 'post-sync',
  async run(ctx) {
    const raw = ctx.config.settings.cleanup ?? {};
    const settings = CleanupSettingsSchema.parse(raw);

    const archived = await ctx.ports.connector.archiveStale(settings, ctx);

    ctx.logger.info('cleanup: archived stale jobs', {
      archived,
      passedOlderThanDays: settings.passedOlderThanDays,
      untouchedOlderThanDays: settings.untouchedOlderThanDays,
    });
  },
};
