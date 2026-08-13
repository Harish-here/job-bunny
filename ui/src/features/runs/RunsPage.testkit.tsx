/**
 * RunsPage.testkit.tsx — shared fixtures for `RunsPage.test.tsx` and
 * `RunsPage.a11y.test.tsx` (the latter split out purely to keep
 * `RunsPage.test.tsx` under the 800-line test-file cap — same precedent as
 * `src/cli/wire/compose.chromedir.test.ts` splitting off `compose.test.ts`).
 * Test-only — not part of the module's public surface (`index.ts`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  DeferredSlotRow,
  RunDetail,
  RunEventRow,
  RunSummary,
} from '../../lib/api/types';
import { RunsPage, todayLocalDate } from './RunsPage';

export const ROWS: RunSummary[] = [
  {
    id: 2,
    date: '2026-08-05',
    timeDir: '09-00',
    kind: 'run',
    resumedFrom: null,
    status: 'passed',
    startedAt: '2026-08-05T09:00:00.000Z',
    finishedAt: '2026-08-05T09:05:00.000Z',
    heartbeatAt: '2026-08-05T09:05:00.000Z',
    progress: null,
    catchupSlots: null,
  },
  {
    id: 1,
    date: '2026-08-04',
    timeDir: '09-00',
    kind: 'stage',
    resumedFrom: null,
    status: 'failed',
    startedAt: '2026-08-04T09:00:00.000Z',
    finishedAt: '2026-08-04T09:01:00.000Z',
    heartbeatAt: '2026-08-04T09:01:00.000Z',
    progress: null,
    catchupSlots: null,
  },
];

export function detailFor(row: RunSummary): RunDetail {
  return {
    ...row,
    result: {
      stages: [
        {
          name: 'filter',
          jobsIn: 10,
          jobsOut: 7,
          dropsByRule: { title: 3 },
          elapsedMs: 100,
          attempts: 1,
        },
      ],
    },
    failure: row.status === 'failed' ? { stage: 'structure', error: 'boom' } : null,
    syncDryrun: null,
  };
}

/** A minimal, valid `FunnelStage[]` fixture — mirrors RunsList.test.tsx's
 * own `stages()` helper. */
export function stageRow(count: number, lastJobsOut: number) {
  const names = [
    'reconcile',
    'farm',
    'source',
    'compress',
    'structure',
    'assemble',
    'filter',
    'dedup',
    'rank',
    'sync',
  ];
  return names.slice(0, count).map((name, i) => ({
    name,
    jobsIn: 10,
    jobsOut: i === count - 1 ? lastJobsOut : 10,
    dropsByRule: {},
    elapsedMs: 100,
    attempts: 1,
  }));
}

export const EVENTS: RunEventRow[] = [
  { ts: '2026-08-05T09:00:01.000Z', level: 'info', msg: 'stage started' },
  { ts: '2026-08-05T09:00:02.000Z', level: 'warn', msg: 'slow request' },
];

export function stubFetch(
  opts: {
    noLocalDb?: boolean;
    serverError?: boolean;
    rows?: RunSummary[];
    /** Per-id override of the `/runs/:id` detail response — lets a test
     * hand back a specific result/failure shape (e.g. a health-gate-failing
     * 9-stage funnel, or a `result: null, failure: null` unrecorded row)
     * instead of the generic `detailFor` fixture. */
    detailOverrides?: Record<number, RunDetail>;
    /** `GET /deferred-slots` rows — defaults to an empty, resolved
     * response so every pre-existing test in this file (which predates
     * D3b) keeps working unchanged. */
    deferredSlotsRows?: DeferredSlotRow[];
    /** Never resolves the `/deferred-slots` fetch — the shape a
     * `deferredQuery.isPending` test needs. */
    deferredSlotsPending?: boolean;
    /** `/deferred-slots` -> 500, the shape a `deferredQuery.isError` test
     * needs, without touching the (separately stubbed) `/runs` response. */
    deferredSlotsError?: boolean;
  } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/deferred-slots')) {
        if (opts.deferredSlotsPending) {
          return new Promise<Response>(() => {}); // never resolves
        }
        if (opts.deferredSlotsError) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              error: { code: 'internal', message: 'internal error' },
            }),
          } as unknown as Response;
        }
        const rows = opts.deferredSlotsRows ?? [];
        return {
          ok: true,
          json: async () => ({ rows, total: rows.length, date: todayLocalDate() }),
        } as unknown as Response;
      }
      // RunsPage now calls useRunControl (B-fix: threading onRun into
      // RunDetailView/DiagnosisPanel), which polls these two endpoints
      // independently of the runs list — stub them so the throw-on-
      // unknown-URL guard below doesn't fire for every test in this file.
      if (url.includes('/run-intents')) {
        return { ok: true, json: async () => ({ rows: [] }) } as unknown as Response;
      }
      if (url.includes('/api/daemon')) {
        return {
          ok: true,
          json: async () => ({
            state: 'stopped',
            pid: null,
            startedAt: null,
            lastTickAt: null,
            inFlight: null,
            profiles: [],
          }),
        } as unknown as Response;
      }
      const eventsMatch = url.match(/\/runs\/(\d+)\/events/);
      if (eventsMatch) {
        return {
          ok: true,
          json: async () => ({ rows: EVENTS, total: 2 }),
        } as unknown as Response;
      }
      const softErrorsMatch = url.match(/\/runs\/(\d+)\/soft-errors/);
      if (softErrorsMatch) {
        return {
          ok: true,
          json: async () => ({ total: 0, groups: [] }),
        } as unknown as Response;
      }
      const detailMatch = url.match(/\/runs\/(\d+)$/);
      if (detailMatch?.[1]) {
        const id = Number(detailMatch[1]);
        const override = opts.detailOverrides?.[id];
        if (override) {
          return { ok: true, json: async () => override } as unknown as Response;
        }
        const rows = opts.rows ?? ROWS;
        const row = rows.find((r) => r.id === id) ?? rows[0];
        if (!row) throw new Error('no fixture row');
        return { ok: true, json: async () => detailFor(row) } as unknown as Response;
      }
      if (url.includes('/runs')) {
        if (opts.noLocalDb) {
          return {
            ok: false,
            status: 404,
            json: async () => ({
              error: { code: 'no_local_db', message: 'no local db' },
            }),
          } as unknown as Response;
        }
        if (opts.serverError) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              error: { code: 'internal', message: 'internal error' },
            }),
          } as unknown as Response;
        }
        const rows = opts.rows ?? ROWS;
        return {
          ok: true,
          json: async () => ({ rows, total: rows.length, limit: 100, offset: 0 }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

export function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunsPage profile="rajni" />
    </QueryClientProvider>,
  );
}
