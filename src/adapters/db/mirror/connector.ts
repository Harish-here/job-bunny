/**
 * MirrorConnector — a composite `Connector` wrapping a primary and a
 * secondary ("mirror") connector (local-DB spec §4, rollout item 3).
 * The primary is the source of truth: reads (`rebuildCache`) and
 * `archiveStale` go to the primary only — the mirror is never consulted
 * for either. (Note: if the mirror is a NotionConnector, its `dryRun`
 * setting is inert here — archive is never called on the mirror.)
 *
 * `syncJobs` writes the primary first (authoritative — its return value
 * and any thrown error propagate untouched) and only then best-effort
 * pushes the same, ORIGINAL jobs to the mirror. Two invariants make this
 * a "never fail, never stall" composite:
 *   - a mirror failure is caught entirely (including non-SoftErrors) and
 *     logged as a warn — it can never fail a run;
 *   - a mirror stall is bounded by its OWN deadline (`budgetMs`, default
 *     one third of the sync stage's 900s budget), raced independently of
 *     `ctx.signal` — a mirror that ignores its own abort signal still
 *     cannot consume the caller's stage budget.
 * Mirror results are never merged into the return value.
 */
import type { DroppedRecord, JD, SyncedJD } from '../../../core/jd/index.ts';
import type { ArchivePolicy, CacheEntry, Connector } from '../../../ports/connector.ts';
import type { RunContext } from '../../../ports/context.ts';

export const MIRROR_BUDGET_MS = 300_000;

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export class MirrorConnector implements Connector {
  readonly name: string;
  private readonly primary: Connector;
  private readonly mirror: Connector;
  private readonly budgetMs: number;

  constructor(
    primary: Connector,
    mirror: Connector,
    budgetMs: number = MIRROR_BUDGET_MS,
  ) {
    this.primary = primary;
    this.mirror = mirror;
    this.budgetMs = budgetMs;
    this.name = `${primary.name}+${mirror.name}`;
  }

  async rebuildCache(ctx: RunContext): Promise<CacheEntry[]> {
    return this.primary.rebuildCache(ctx);
  }

  async archiveStale(
    policy: ArchivePolicy,
    ctx: RunContext,
  ): Promise<{ archived: number; dropped: DroppedRecord[] }> {
    return this.primary.archiveStale(policy, ctx);
  }

  async syncJobs(jobs: JD[], ctx: RunContext): Promise<SyncedJD[]> {
    const results = await this.primary.syncJobs(jobs, ctx);
    // Mirror budget: the push is bounded by its OWN deadline, not the sync
    // stage's. Without this, a slow (not failing) Notion consumes the stage
    // budget and fails a run whose local write already succeeded — the exact
    // outcome this composite exists to prevent. The race guards even a mirror
    // that ignores its signal.
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.budgetMs)]);
    try {
      const push = this.mirror.syncJobs(jobs, { ...ctx, signal });
      push.catch(() => {}); // losing the race must never surface as unhandledRejection
      const mirrored = await Promise.race([push, rejectOnAbort(signal)]);
      const detail = {
        mirror: this.mirror.name,
        pushed: mirrored.length,
        of: jobs.length,
      };
      if (mirrored.length < jobs.length) {
        ctx.logger.warn(
          'mirror: partial push — some jobs did not reach the secondary',
          detail,
        );
      } else {
        ctx.logger.info('mirror: pushed jobs to secondary', detail);
      }
    } catch (err) {
      ctx.logger.warn(
        'mirror: push failed — run continues, local store is authoritative',
        {
          mirror: this.mirror.name,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return results;
  }

  close(): void {
    this.primary.close?.();
    this.mirror.close?.();
  }
}
