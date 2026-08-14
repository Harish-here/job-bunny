/**
 * RunsPage.a11y.test.tsx — split out of `RunsPage.test.tsx` purely to stay
 * under the 800-line test-file cap (same precedent as
 * `src/cli/wire/compose.chromedir.test.ts` splitting off `compose.test.ts`;
 * shared fixtures live in `RunsPage.testkit.tsx`).
 *
 * BUG 10 (pipeline-stability-hardening QA round 3, 2026-08-14) — ux-notes
 * §9 verbatim: "it must not enter the runs listbox." `RunsList.tsx` used to
 * render the deferred group's `insertContent` *inside* the single
 * `role="listbox"`, between two `role="option"` rows — a div holding a
 * paragraph/region/heading/button is not a permitted listbox child (ARIA
 * 1.2 requires only `option`, or `group` of `option`s), and AT that prunes
 * disallowed children drops the whole group from the accessibility tree.
 * Exercised here at the full RunsPage integration level (real
 * `DeferredGroup`, real `RunsList`, real fetch stubs) rather than only at
 * `RunsList`'s own unit level (see `RunsList.test.tsx`'s own BUG 10
 * describe block for the lower-level, non-DeferredGroup version of the
 * same guard), so the fix is proven in the exact wiring QA drove.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeferredSlotRow, RunSummary } from '../../lib/api/types';
import { todayLocalDate } from './RunsPage';
import { ROWS, renderPage, stubFetch } from './RunsPage.testkit';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BUG 10 — the deferred group must never enter role="listbox"', () => {
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
  const fiveDeferredRows: DeferredSlotRow[] = [
    '09:00',
    '11:30',
    '14:00',
    '16:30',
    '19:00',
  ].map((slotTime) => ({
    runDate: today,
    slot: slotTime,
    reasonCode: 'host-asleep',
    reason: 'Job Bunny declined to start this run because the host was asleep.',
    decidedAt: `${today}T${slotTime}:05.000Z`,
    notifiedAt: null,
  }));

  it('catch-up-ran case: the listbox(es) contain ONLY option children, the group is not a listbox descendant, order holds, and all 5 entries render', async () => {
    stubFetch({ rows: [catchupRow, olderRow], deferredSlotsRows: fiveDeferredRows });
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId(/^deferred-slot-entry-\d+$/)).toHaveLength(5);
    });

    // STANDING GUARD — the exact assertion that would have caught BUG 10:
    // no non-option ever sits directly inside a listbox.
    expect(
      container.querySelectorAll('[role="listbox"] > *:not([role="option"])'),
    ).toHaveLength(0);

    const deferredGroup = screen.getByTestId('deferred-group');
    expect(deferredGroup.closest('[role="listbox"]')).toBeNull();

    // Order across all three elements: catch-up row -> deferred group ->
    // older run.
    const catchupRowEl = container.querySelector(
      '[data-qa="run-row-catchup"]',
    ) as HTMLElement;
    const olderRowEl = screen
      .getAllByTestId('run-row')
      .find(
        (el) => el.getAttribute('data-run-id') === String(olderRow.id),
      ) as HTMLElement;
    expect(
      catchupRowEl.compareDocumentPosition(deferredGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      deferredGroup.compareDocumentPosition(olderRowEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('no-catch-up case: still exactly one listbox, still only option children, still all 5 entries, group still above the list', async () => {
    stubFetch({ deferredSlotsRows: fiveDeferredRows });
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId(/^deferred-slot-entry-\d+$/)).toHaveLength(5);
    });

    expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(
      container.querySelectorAll('[role="listbox"] > *:not([role="option"])'),
    ).toHaveLength(0);

    const deferredGroup = screen.getByTestId('deferred-group');
    expect(deferredGroup.closest('[role="listbox"]')).toBeNull();

    const firstRunRow = screen.getAllByTestId('run-row')[0] as HTMLElement;
    expect(
      deferredGroup.compareDocumentPosition(firstRunRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keyboard operability of the toggle survives the fix: Enter toggles the entries 5 -> 0 -> 5', async () => {
    stubFetch({ rows: [catchupRow, olderRow], deferredSlotsRows: fiveDeferredRows });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId(/^deferred-slot-entry-\d+$/)).toHaveLength(5);
    });

    const toggle = screen.getByTestId('deferred-group-toggle');
    toggle.focus();
    expect(toggle).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(screen.queryAllByTestId(/^deferred-slot-entry-\d+$/)).toHaveLength(0);

    await userEvent.keyboard('{Enter}');
    expect(screen.getAllByTestId(/^deferred-slot-entry-\d+$/)).toHaveLength(5);
  });
});
