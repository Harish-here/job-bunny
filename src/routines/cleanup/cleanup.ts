import { z } from 'zod';
import type { Routine } from '../types.ts';

/**
 * cleanup routine (P7 Task 5) — archives stale Notion rows via
 * `ctx.ports.connector.archiveStale`, whose exact staleness rules live in
 * `adapters/db/notion/archive.ts` (ported from v0 `scripts/notion/
 * cleanup.js`): Status=Passed pages older than `passedOlderThanDays`, and
 * pages with NO Status at all (never triaged — `syncJobs` never writes
 * Status) older than `untouchedOlderThanDays`. It then prunes local
 * `runs/<date>/` checkpoint folders older than `runsOlderThanDays` via
 * `ctx.storage` — a purely local-disk concern, unrelated to Notion
 * staleness.
 *
 * Settings come from the pipeline config's `settings.cleanup` slice
 * (`PipelineConfigSchema.settings` is an untyped `Record<string, unknown>`
 * — each routine/adapter owns and validates its own key). A `Routine` is a
 * plain object, not a class with a constructor, so — unlike
 * `NotionConnector`'s settings, validated once at construction — this
 * validates on every `run()` instead ("at first use", per the task). An
 * absent `settings.cleanup` key parses to the pinned v0 defaults, not an
 * error: `passedOlderThanDays: 7`, `untouchedOlderThanDays: 30` (v0
 * `cleanup.js`'s own `DAYS_OLD`/`LEAD_DAYS_OLD` env-var defaults);
 * `runsOlderThanDays` has no v0 precedent (v0 never wrote checkpoints) and
 * defaults to 30.
 *
 * Dry-run is deliberately NOT modeled here: it belongs entirely to the
 * connector's own settings (`NotionConnectorSettings.dryRun`, defaulting to
 * `true` — v0's `--apply`/`CLEANUP_APPLY` opt-in invariant). This routine
 * always calls `archiveStale`; whether that call actually writes anything
 * is a decision owned by the connector and never overridden here. Run-folder
 * pruning has no equivalent dry-run knob — deleting an old checkpoint
 * folder is not a Notion write and carries no undo requirement.
 */
export const CleanupSettingsSchema = z.object({
  /** v0 `cleanup.js` `DAYS_OLD` default. */
  passedOlderThanDays: z.number().int().min(0).default(7),
  /** v0 `cleanup.js` `LEAD_DAYS_OLD` default. */
  untouchedOlderThanDays: z.number().int().min(0).default(30),
  /** No v0 precedent (v0 never wrote checkpoints); TTL for local
   * `runs/<date>/` folders under `ctx.storage` (legacy, pre-Phase-2) and
   * for `checkpoints`/`runs` table rows (persist-to-db). */
  runsOlderThanDays: z.number().int().min(0).default(30),
});

export type CleanupSettings = z.infer<typeof CleanupSettingsSchema>;

const RUN_DIR_NAME = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure selection of which `runs/` subdirectory names are prunable: only
 * date-shaped names (`YYYY-MM-DD`) strictly older than `today` minus
 * `ttlDays` are returned. `today` never comes back even at `ttlDays: 0` —
 * this routine runs post-sync *during* a run whose own `runs/<today>/`
 * folder is actively being written to, so a same-day match must never be
 * eligible regardless of TTL. `today` is passed in (not read via
 * `Date.now()`) to keep this helper deterministic and testable.
 */
export function selectPrunableRunDirs(
  dirNames: string[],
  today: string,
  ttlDays: number,
): string[] {
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - ttlDays);
  return dirNames.filter((name) => {
    if (name === today) return false;
    if (!RUN_DIR_NAME.test(name)) return false;
    return new Date(`${name}T00:00:00.000Z`) < cutoff;
  });
}

export const cleanupRoutine: Routine = {
  name: 'cleanup',
  when: 'post-sync',
  async run(ctx) {
    const raw = ctx.config.settings.cleanup ?? {};
    const settings = CleanupSettingsSchema.parse(raw);

    const { archived, dropped } = await ctx.ports.connector.archiveStale(
      {
        passedOlderThanDays: settings.passedOlderThanDays,
        untouchedOlderThanDays: settings.untouchedOlderThanDays,
      },
      ctx,
    );

    ctx.logger.info('cleanup: archived stale jobs', {
      archived,
      passedOlderThanDays: settings.passedOlderThanDays,
      untouchedOlderThanDays: settings.untouchedOlderThanDays,
    });

    // Routines run outside the job-flow pipeline (`when: 'post-sync'`, after
    // `runPipeline` has already returned) — there is no next StageDef to
    // merge these into a StagePayload.dropped funnel the way `sync.ts`
    // does. Logging every archive-failure DroppedRecord here (instead of
    // just the aggregate `archived` count above) is the most this routine
    // can do on its own to keep them from vanishing into a per-page warn
    // line alone; genuinely wiring routine drops into RunResult's funnel
    // would mean widening `Routine.run`'s return type and `runRoutines` in
    // `cli/commands/run.ts`, which is out of scope here.
    if (dropped.length > 0) {
      ctx.logger.warn('cleanup: some stale pages failed to archive', {
        count: dropped.length,
        pages: dropped.map((d) => ({
          id: d.jd.identity.id,
          detail: d.reasons[0]?.detail,
        })),
      });
    }

    // LEGACY (pre-Phase-2 leftover `runs/<date>/` folders): harmless once
    // none remain on disk after an upgrade, and independent of the
    // checkpoints-table prune below. This routine runs post-sync DURING a
    // run whose own `runs/<today>/` checkpoint folder is actively being
    // written — `selectPrunableRunDirs`'s never-today guard plus its
    // strict-older-than-cutoff comparison make pruning alongside that live
    // folder safe.
    const today = new Date().toISOString().slice(0, 10);
    const runDirs = await ctx.storage.listSubdirs('runs');
    const prunable = selectPrunableRunDirs(runDirs, today, settings.runsOlderThanDays);

    let prunedRuns = 0;
    const prunedNames: string[] = [];
    for (const dir of prunable) {
      try {
        await ctx.storage.removeTree(`runs/${dir}`);
        prunedRuns += 1;
        prunedNames.push(dir);
      } catch (err) {
        ctx.logger.warn('cleanup: failed to prune a run folder', {
          dir,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    ctx.logger.debug('cleanup: pruned run folders', { prunedNames });
    ctx.logger.info('cleanup: pruned local run folders', {
      prunedRuns,
      runsOlderThanDays: settings.runsOlderThanDays,
    });

    // Same TTL, same `today` as the folder prune above — `runs`/`run_events`
    // rows (persist-to-db Phase 1) get pruned alongside the checkpoint
    // folders they currently correlate to via `timeDir` (Phase 2 retires
    // the folders; this prune stays independent of that).
    const prunedDbRuns = ctx.runStore.pruneRunsOlderThan(
      today,
      settings.runsOlderThanDays,
    );
    ctx.logger.info('cleanup: pruned run rows', {
      prunedDbRuns,
      runsOlderThanDays: settings.runsOlderThanDays,
    });

    // Same TTL, same `today` as the runs-row prune above — checkpoint rows
    // (persist-to-db Phase 2) get pruned the same way. The legacy
    // `runs/<date>/` folder prune above stays for pre-Phase-2 leftovers
    // still on disk after an upgrade — harmless once none remain.
    //
    // `CheckpointStore.pruneOlderThan` is LOUD by its own port contract
    // (recovery-path methods must never silently lose a checkpoint) — but
    // this caller is TTL housekeeping running post-sync, after the run
    // this routine belongs to has already passed. Letting a prune failure
    // (e.g. SQLITE_BUSY from a second open connection on the same WAL file)
    // propagate out of here would red an otherwise-passed run and swallow
    // its own success digest — exactly the class of destabilization the
    // stability principle rejects. Caught and warned, matching the
    // `removeTree` per-folder handler above.
    try {
      const prunedCheckpoints = ctx.checkpointStore.pruneOlderThan(
        today,
        settings.runsOlderThanDays,
      );
      ctx.logger.info('cleanup: pruned checkpoint rows', {
        prunedCheckpoints,
        runsOlderThanDays: settings.runsOlderThanDays,
      });
    } catch (err) {
      ctx.logger.warn('cleanup: checkpoint prune failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
