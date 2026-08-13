import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DeferredSlotRow,
  GetRunResponse,
  RunDetail,
  RunSummary,
} from '../../lib/api/types';
import { todayLocalDate } from './RunsPage';
import { detailFor, ROWS, renderPage, stageRow, stubFetch } from './RunsPage.testkit';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunsPage', () => {
  it('renders rows, selects the newest by default, and shows its funnel + events', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('run-row')[0]).toHaveAttribute('aria-selected', 'true');

    await waitFor(() => {
      expect(screen.getByText('filter')).toBeInTheDocument();
    });
    expect(screen.getByText('10 → 7')).toBeInTheDocument();
    expect(screen.getByText('title: 3')).toBeInTheDocument();

    // Events live behind EvidenceSection's disclosure, closed by default (B19).
    await userEvent.click(
      screen.getByTestId('evidence-disclosure-trigger') as HTMLElement,
    );
    expect(screen.getByText('stage started')).toBeInTheDocument();
  });

  it('renders a freshness chip derived from the runs-list query dataUpdatedAt (B23)', async () => {
    stubFetch();
    renderPage();

    // dataUpdatedAt lands within the same test tick as the resolved fetch,
    // so formatRelative's own <60s bucket ("just now") is what a fresh
    // successful poll always renders — no fake timers needed.
    await waitFor(() => {
      expect(screen.getByTestId('freshness-chip')).toHaveTextContent(/updated just now/i);
    });
  });

  it('shows a disconnected freshness chip on a server failure (B23, R11)', async () => {
    stubFetch({ serverError: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('freshness-chip')).toHaveTextContent(/disconnected/i);
    });
    // Stalled ≠ disconnected (ux-notes §9, R11) — the chip's wording must
    // not read as a generic freshness update once the poll itself fails.
    expect(screen.getByTestId('freshness-chip')).not.toHaveTextContent(/updated/i);
  });

  it('clicking a row selects it and shows its failed-stage banner', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await userEvent.click(screen.getAllByTestId('run-row')[1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText(/Failed at stage: structure/)).toBeInTheDocument();
    });
  });

  it('shows the empty state for a profile with no runs', async () => {
    stubFetch({ rows: [] });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('runs-empty')).toBeInTheDocument();
    });
    expect(screen.getByText(/no runs recorded yet/i)).toBeInTheDocument();
    expect(screen.getByText('No run selected.')).toBeInTheDocument();
  });

  it('shows a friendly empty state for a profile with no local database', async () => {
    stubFetch({ noLocalDb: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/no local database/i)).toBeInTheDocument();
    });
  });

  it('shows a distinct error state on a server failure', async () => {
    stubFetch({ serverError: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/couldn't load runs/i).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /retry/i }).length).toBeGreaterThan(0);
  });

  it('renders the live run header for an in-flight run', async () => {
    const runningRows: RunSummary[] = [
      {
        id: 3,
        date: '2026-08-06',
        timeDir: '09-00',
        kind: 'run',
        resumedFrom: null,
        status: 'running',
        startedAt: '2026-08-06T09:00:00.000Z',
        finishedAt: null,
        heartbeatAt: '2026-08-06T09:00:05.000Z',
        progress: null,
        catchupSlots: null,
      },
      ...ROWS,
    ];
    stubFetch({ rows: runningRows });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('live-run-header')).toBeInTheDocument();
    });
    expect(screen.getByTestId('live-run-stage')).toHaveTextContent('Running — starting…');
  });

  it('classifies passed/crashed list rows via fetched RunDetail, not the bare RunSummary fallback (regression)', async () => {
    // `listRuns()` — the real `/api/profiles/:name/runs` response — only
    // ever returns RunSummary rows (no `result`/`failure`). classifyOutcome
    // can only resolve produced/empty/degraded/unrecorded from a RunDetail,
    // so RunsPage must hydrate these rows with fetched detail before
    // RunsList renders them, or every 'passed' row degrades and every
    // truly-unrecorded 'crashed' row reads as generic 'crashed'.
    const rows: RunSummary[] = [
      {
        id: 10,
        date: '2026-08-07',
        timeDir: '09-00',
        kind: 'run',
        resumedFrom: null,
        status: 'passed',
        startedAt: '2026-08-07T09:00:00.000Z',
        finishedAt: '2026-08-07T09:05:00.000Z',
        heartbeatAt: '2026-08-07T09:05:00.000Z',
        progress: null,
        catchupSlots: null,
      },
      {
        id: 11,
        date: '2026-08-07',
        timeDir: '08-00',
        kind: 'run',
        resumedFrom: null,
        status: 'passed',
        startedAt: '2026-08-07T08:00:00.000Z',
        finishedAt: '2026-08-07T08:05:00.000Z',
        heartbeatAt: '2026-08-07T08:05:00.000Z',
        progress: null,
        catchupSlots: null,
      },
      {
        id: 12,
        date: '2026-08-07',
        timeDir: '07-00',
        kind: 'run',
        resumedFrom: null,
        status: 'passed',
        startedAt: '2026-08-07T07:00:00.000Z',
        finishedAt: '2026-08-07T07:05:00.000Z',
        heartbeatAt: '2026-08-07T07:05:00.000Z',
        progress: null,
        catchupSlots: null,
      },
      {
        id: 13,
        date: '2026-08-07',
        timeDir: '06-00',
        kind: 'run',
        resumedFrom: null,
        status: 'crashed',
        startedAt: '2026-08-07T06:00:00.000Z',
        finishedAt: '2026-08-07T06:01:00.000Z',
        heartbeatAt: '2026-08-07T06:01:00.000Z',
        progress: null,
        catchupSlots: null,
      },
    ];
    const detailOverrides: Record<number, RunDetail> = {
      10: {
        ...(rows[0] as RunSummary),
        result: { stages: stageRow(10, 7) },
        failure: null,
        syncDryrun: null,
      }, // produced: last stage jobsOut > 0
      11: {
        ...(rows[1] as RunSummary),
        result: { stages: stageRow(10, 0) },
        failure: null,
        syncDryrun: null,
      }, // empty: all 10 stages, zero-yield, health gate passes
      12: {
        ...(rows[2] as RunSummary),
        result: { stages: stageRow(9, 0) },
        failure: null,
        syncDryrun: null,
      }, // degraded: only 9 stages recorded, fails the health gate
      13: {
        ...(rows[3] as RunSummary),
        result: null,
        failure: null,
        syncDryrun: null,
      }, // unrecorded: crashed with both blobs genuinely null
    };
    stubFetch({ rows, detailOverrides });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(4);
    });

    await waitFor(() => {
      const kinds = new Map(
        screen
          .getAllByTestId('run-row')
          .map((el) => [
            Number(el.getAttribute('data-run-id')),
            el.getAttribute('data-outcome-kind'),
          ]),
      );
      expect(kinds.get(10)).toBe('produced');
      expect(kinds.get(11)).toBe('empty');
      expect(kinds.get(12)).toBe('degraded');
      expect(kinds.get(13)).toBe('unrecorded');
    });
  });

  it('renders no live run header when every run has finished', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    expect(screen.queryByTestId('live-run-header')).not.toBeInTheDocument();
  });

  it('renders the day-reassurance line with an explicit 0 failed when nothing happened today (D3b)', async () => {
    // The default ROWS fixture's dates (2026-08-04/05) never equal
    // `todayLocalDate()`'s real-clock value, so today-scoped counts are
    // all zero — proving the "0 failed" case is rendered explicitly, not
    // omitted (data-qa-ids.md's own load-bearing note).
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(`${todayLocalDate()} · 0 runs, 0 slots deferred, 0 failed`),
      ).toBeInTheDocument();
    });
  });

  it('scopes runCount/failedCount to TODAY only, excluding other-day rows (D3b)', async () => {
    const today = todayLocalDate();
    const todaysPassed: RunSummary = {
      ...(ROWS[0] as RunSummary),
      id: 21,
      date: today,
      status: 'passed',
    };
    const todaysFailed: RunSummary = {
      ...(ROWS[1] as RunSummary),
      id: 22,
      date: today,
      status: 'failed',
    };
    const otherDayFailed: RunSummary = {
      ...(ROWS[1] as RunSummary),
      id: 23,
      date: '2020-01-01',
      status: 'failed',
    };
    const deferredSlotsRows: DeferredSlotRow[] = [1, 2, 3].map((n) => ({
      runDate: today,
      slot: `0${n}:00`,
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
      decidedAt: `${today}T0${n}:00:05.000Z`,
      notifiedAt: null,
    }));
    stubFetch({
      rows: [todaysPassed, todaysFailed, otherDayFailed],
      deferredSlotsRows,
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(`${today} · 2 runs, 3 slots deferred, 1 failed`),
      ).toBeInTheDocument();
    });
  });

  it('no-catch-up case: places the deferred group above the run rows, not below all of them (BUG 3)', async () => {
    // With just 2 rows the off-screen symptom itself isn't reproducible
    // (both bug and fix scroll into view identically at that size) — the
    // assertion below checks *document order* directly rather than
    // relying on viewport position, so it still catches the regression
    // regardless of row count. `ROWS` (>1 row) is used anyway to match
    // the bug's own reproduction condition, not because the assertion
    // needs it. Neither `ROWS` row has `catchupSlots` set, so this is the
    // "no catch-up ran today" case — the group belongs at the TOP of the
    // list, directly under the reassurance line.
    const deferredSlotsRows: DeferredSlotRow[] = [
      {
        runDate: todayLocalDate(),
        slot: '09:00',
        reasonCode: 'host-asleep',
        reason: 'Job Bunny declined to start this run because the host was asleep.',
        decidedAt: `${todayLocalDate()}T09:00:05.000Z`,
        notifiedAt: null,
      },
    ];
    stubFetch({ deferredSlotsRows });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('deferred-group')).toBeInTheDocument();
    });

    const deferredGroup = screen.getByTestId('deferred-group');
    const firstRunRow = screen.getAllByTestId('run-row')[0] as HTMLElement;
    // DOCUMENT_POSITION_FOLLOWING set on the comparison target means
    // `firstRunRow` comes AFTER `deferredGroup` in the DOM — i.e. the
    // group precedes the run rows, matching mockup.html's S1 order
    // (day reassurance -> catch-up row -> deferred group -> older runs).
    const position = deferredGroup.compareDocumentPosition(firstRunRow);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('catch-up-ran case: places the deferred group AFTER the catch-up row and BEFORE the older runs, never above the catch-up row (BUG 3 round 2)', async () => {
    // Round-2 regression: the group's own fix landed above EVERYTHING,
    // including the catch-up row — inverting ux-notes callout 6's Von
    // Restorff intent (the eye must land on the green catch-up row that
    // covered the day, not on the deferred footnote sitting above it).
    const today = todayLocalDate();
    const catchupRow: RunSummary = {
      id: 40,
      date: today,
      timeDir: '09-00',
      kind: 'catchup',
      resumedFrom: null,
      status: 'passed',
      startedAt: `${today}T09:00:00.000Z`,
      finishedAt: `${today}T09:05:00.000Z`,
      heartbeatAt: `${today}T09:05:00.000Z`,
      progress: null,
      catchupSlots: ['09:00', '11:30'],
    };
    const olderRow = ROWS[0] as RunSummary; // catchupSlots: null, a different date.
    const deferredSlotsRows: DeferredSlotRow[] = [
      {
        runDate: today,
        slot: '09:00',
        reasonCode: 'host-asleep',
        reason: 'Job Bunny declined to start this run because the host was asleep.',
        decidedAt: `${today}T09:00:05.000Z`,
        notifiedAt: null,
      },
    ];
    stubFetch({ rows: [catchupRow, olderRow], deferredSlotsRows });
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('deferred-group')).toBeInTheDocument();
    });

    const reassurance = container.querySelector(
      '[data-qa="runs-day-reassurance"]',
    ) as HTMLElement;
    const catchupRowEl = container.querySelector(
      '[data-qa="run-row-catchup"]',
    ) as HTMLElement;
    const deferredGroup = screen.getByTestId('deferred-group');
    const olderRowEl = screen
      .getAllByTestId('run-row')
      .find(
        (el) => el.getAttribute('data-run-id') === String(olderRow.id),
      ) as HTMLElement;

    expect(catchupRowEl).toBeInTheDocument();
    expect(olderRowEl).toBeInTheDocument();

    // Required order: reassurance -> catch-up row -> deferred group ->
    // older runs. DOCUMENT_POSITION_FOLLOWING on the comparison target
    // means the target comes AFTER the node compareDocumentPosition was
    // called on.
    expect(
      reassurance.compareDocumentPosition(catchupRowEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      catchupRowEl.compareDocumentPosition(deferredGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      deferredGroup.compareDocumentPosition(olderRowEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('deferred region shows exactly one Skeleton while its query is pending (never three, D3b)', async () => {
    stubFetch({ deferredSlotsPending: true });
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });

    // The runs-list's own loading skeletons are gone once its rows
    // render; the deferred region's single Skeleton is the only one left.
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
  });

  it('a deferred-slots fetch error renders a scoped retry without blanking the runs list next to it (D3b)', async () => {
    stubFetch({ deferredSlotsError: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByText(/couldn't load deferred slots/i)).toBeInTheDocument();
    });
    // The runs list itself is unaffected — a deferred-slots failure must
    // not blank the whole pane it sits in.
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
  });

  // Task 27 (blueprint step 1.6a): `estimatedDurationMs` threads from
  // `RunsPage`'s already-fetched `detailQuery` into `LiveRunHeader`, but
  // ONLY when the selected/detail-viewed run is the SAME run as the live
  // one — never a stale or mismatched value from a different selection.
  // `LiveRunHeader`'s own `catchup-banner-eta` text (rendered only for a
  // `kind: 'catchup'`, heartbeat-fresh running row) is the simplest
  // observable proxy per this file's existing convention of asserting on
  // rendered DOM rather than spying on child components.
  describe('estimatedDurationMs threading into LiveRunHeader (task 27)', () => {
    const RUNNING_CATCHUP: RunSummary = {
      id: 30,
      date: todayLocalDate(),
      timeDir: '09-00',
      kind: 'catchup',
      resumedFrom: null,
      status: 'running',
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      finishedAt: null,
      heartbeatAt: new Date().toISOString(),
      progress: null,
      catchupSlots: ['09:00'],
    };
    const OLDER_ROW = ROWS[0] as RunSummary; // status: 'passed', id 2

    it("passes the detail query's exact estimatedDurationMs when the selected run matches the running row", async () => {
      const runningDetail: GetRunResponse = {
        ...detailFor(RUNNING_CATCHUP),
        estimatedDurationMs: 25 * 60_000,
      };
      // Running row first -> default-selected (RunsPage selects rows[0] on
      // load), so detailQuery.data.id === runningRow.id from the start.
      stubFetch({
        rows: [RUNNING_CATCHUP, OLDER_ROW],
        detailOverrides: { 30: runningDetail },
      });
      const { container } = renderPage();

      await waitFor(() => {
        expect(screen.getByTestId('live-run-header')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(
          container.querySelector('[data-qa="catchup-banner-eta"]'),
        ).toHaveTextContent('~25 min left');
      });
      expect(
        container.querySelector('[data-qa="catchup-banner-stop-unavailable"]'),
      ).toHaveTextContent('about 25 min left');
    });

    it('passes null (not a stale/mismatched value) once the operator selects a different, non-running row', async () => {
      const runningDetail: GetRunResponse = {
        ...detailFor(RUNNING_CATCHUP),
        estimatedDurationMs: 40 * 60_000,
      };
      // Running row is default-selected first, so the strip briefly shows
      // its own real estimate — this is the exact "prior selection" the
      // guard must not leak once the operator clicks elsewhere.
      stubFetch({
        rows: [RUNNING_CATCHUP, OLDER_ROW],
        detailOverrides: { 30: runningDetail },
      });
      const { container } = renderPage();

      await waitFor(() => {
        expect(
          container.querySelector('[data-qa="catchup-banner-eta"]'),
        ).toHaveTextContent('~40 min left');
      });

      // Operator clicks an older, finished row while the catch-up run is
      // still live in the background — selectedId now diverges from
      // runningRow.id.
      await waitFor(() => {
        expect(screen.getAllByTestId('run-row')).toHaveLength(2);
      });
      await userEvent.click(screen.getAllByTestId('run-row')[1] as HTMLElement);

      // The live header is still rendered (the catch-up run is still
      // running) but must now show the no-estimate copy, never the stale
      // 40-minute value from the earlier, matching selection.
      expect(screen.getByTestId('live-run-header')).toBeInTheDocument();
      await waitFor(() => {
        const eta = container.querySelector('[data-qa="catchup-banner-eta"]');
        expect(eta).toHaveTextContent(/elapsed/);
        expect(eta).not.toHaveTextContent('40 min left');
      });
      expect(
        container.querySelector('[data-qa="catchup-banner-stop-unavailable"]'),
      ).toHaveTextContent('Runs to completion.');
    });
  });
});
