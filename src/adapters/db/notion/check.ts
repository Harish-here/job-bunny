import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';
import type { CallContext } from './client.ts';

/**
 * dbReachableCheck (P8) — DoctorCheck confirming the configured Notion
 * database can actually be queried. Mirrors
 * `adapters/lanes/linkedin/inventory.ts`'s factory-returns-`{ name, run() }`
 * shape; `run()` never throws.
 *
 * `NotionApiLike` is a narrow slice of `NotionApi` (just `queryDatabase`, the
 * cheapest existing read on the client — `client.ts` exposes no lighter
 * "retrieve database metadata" call) so tests can inject a fake without
 * constructing a real `NotionApi`/SDK client. A real `NotionApi` instance
 * satisfies this structurally, no adapter needed.
 *
 * Empty/absent `dbId` (an unconfigured connector, e.g. the `rajni` fixture
 * profile) ⇒ warn, not red — that's a valid "Notion isn't wired up for this
 * profile" state, not a failure. Otherwise: a successful query ⇒ ok;
 * auth/permission/not-found ⇒ red (the DB is misconfigured or inaccessible);
 * anything else (network, timeout, transient 5xx) ⇒ warn.
 */
export interface NotionApiLike {
  queryDatabase(databaseId: string, ctx: CallContext): Promise<unknown[]>;
}

export interface DbReachableCheckDeps {
  api: NotionApiLike;
  dbId: string;
}

const AUTH_STATUSES = new Set([401, 403, 404]);

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function dbReachableCheck(deps: DbReachableCheckDeps): DoctorCheck {
  const name = 'notion-db-reachable';
  return {
    name,
    async run(): Promise<DoctorFinding> {
      if (!deps.dbId) {
        return { check: name, status: 'warn', detail: 'no Notion DB configured' };
      }
      try {
        await deps.api.queryDatabase(deps.dbId, { signal: new AbortController().signal });
        return { check: name, status: 'ok', detail: 'Notion database is reachable' };
      } catch (err) {
        const status = statusOf(err);
        if (status !== undefined && AUTH_STATUSES.has(status)) {
          return {
            check: name,
            status: 'red',
            detail: `Notion database not reachable (HTTP ${status}): ${errorMessage(err)}`,
          };
        }
        return {
          check: name,
          status: 'warn',
          detail: `could not reach Notion to verify the database: ${errorMessage(err)}`,
        };
      }
    },
  };
}
