import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  RunDetail,
  RunProgress,
  RunSummary,
  SoftErrorSummary,
} from '../../lib/api/types';
import { RunsList } from './RunsList';
import type { OutcomeKind } from './runOutcome';

// The frozen 10-stage pipeline order (CLAUDE.md "Pipeline architecture").
const STAGE_NAMES = [
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

function stages(count: number, lastJobsOut: number) {
  return STAGE_NAMES.slice(0, count).map((name, i) => ({
    name,
    jobsIn: 10,
    jobsOut: i === count - 1 ? lastJobsOut : 10,
    dropsByRule: {},
    elapsedMs: 100,
    attempts: 1,
  }));
}

/** A realistic zero-yield funnel where `farm` reports its known-limitation
 * `jobsIn: 0` (CLAUDE.md "Known limitations") while `source` — the first
 * retention-eligible stage — actually scraped 214 jobs. Used to prove the
 * calm-empty subline reads its "scraped" count from `source`, never from
 * `farm`'s misleading literal `0`. */
const FARM_SAFE_STAGES = STAGE_NAMES.map((name, i) => ({
  name,
  jobsIn: name === 'reconcile' || name === 'farm' ? 0 : 214,
  jobsOut: i === STAGE_NAMES.length - 1 ? 0 : 214,
  dropsByRule: {},
  elapsedMs: 100,
  attempts: 1,
}));

// Every fixture shares this exact wall-clock window ON PURPOSE: if row text
// were accidentally distinct only because timestamps differ, the greyscale
// test below would pass for the wrong reason. Holding time constant forces
// distinctness to come from the outcome-specific label/number/subline text
// alone — the actual insurance ux-notes §11 asks for.
const BASE = {
  date: '2026-08-05',
  timeDir: '09-00',
  kind: 'run' as const,
  resumedFrom: null,
  startedAt: '2026-08-05T09:00:00.000Z',
  finishedAt: '2026-08-05T09:05:00.000Z',
  heartbeatAt: '2026-08-05T09:05:00.000Z',
  progress: null,
  catchupSlots: null,
};

const RUNNING_PROGRESS: RunProgress = {
  stage: 'structure',
  stageIndex: 5,
  stageTotal: 10,
  stageStartedAt: '2026-08-05T09:03:00.000Z',
  updatedAt: '2026-08-05T09:04:00.000Z',
  itemCurrent: null,
  itemTotal: null,
};

// One fixture per `OutcomeKind` (7 total), in the order plan.md's B21
// "Done" line enumerates them. Insertion order is preserved for `Object`
// keys, so this doubles as the render order below.
const FIXTURES: Record<OutcomeKind, RunSummary | RunDetail> = {
  produced: {
    id: 1,
    ...BASE,
    status: 'passed',
    result: { stages: stages(10, 7) },
    failure: null,
    syncDryrun: null,
  },
  empty: {
    id: 2,
    ...BASE,
    status: 'passed',
    result: { stages: FARM_SAFE_STAGES },
    failure: null,
    syncDryrun: null,
  },
  degraded: {
    id: 3,
    ...BASE,
    status: 'passed',
    result: { stages: stages(9, 0) }, // fewer than 10 stages fails the health gate
    failure: null,
    syncDryrun: null,
  },
  failed: {
    id: 4,
    ...BASE,
    status: 'failed',
    result: null,
    failure: { stage: 'structure', error: 'boom', elapsedMs: 500 },
    syncDryrun: null,
  },
  crashed: {
    id: 5,
    ...BASE,
    status: 'crashed',
    result: null,
    failure: { stage: 'source', error: 'lost contact', elapsedMs: 1000 },
    syncDryrun: null,
  },
  running: {
    id: 6,
    ...BASE,
    status: 'running',
    finishedAt: null,
    progress: RUNNING_PROGRESS,
  },
  unrecorded: {
    id: 7,
    ...BASE,
    status: 'crashed',
    result: null,
    failure: null,
    syncDryrun: null,
  },
};

const KIND_ORDER = Object.keys(FIXTURES) as OutcomeKind[];
const ROWS = KIND_ORDER.map((kind) => FIXTURES[kind]);

const URGENT_THREE: OutcomeKind[] = ['degraded', 'failed', 'crashed'];

/** Matches only the urgent-three's amber/destructive left-border accent —
 * deliberately excludes `running`'s `border-l-primary`, which is a real
 * left border (ux-notes §1) but a different treatment, not to be conflated
 * with the urgent three (plan.md B21 step 4). */
function hasUrgentBorder(el: Element): boolean {
  return /\bborder-l-(amber|destructive)\b/.test(el.className);
}

describe('RunsList — 7-way outcome treatment (B21, AC3)', () => {
  it('renders exactly one row per OutcomeKind, in order', () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    const rowEls = screen.getAllByTestId('run-row');
    expect(rowEls).toHaveLength(7);
    expect(rowEls.map((el) => el.getAttribute('data-outcome-kind'))).toEqual(KIND_ORDER);
  });

  it('(a) weight-not-hue: exactly degraded/failed/crashed carry the urgent left-border accent', () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    for (const rowEl of screen.getAllByTestId('run-row')) {
      const kind = rowEl.getAttribute('data-outcome-kind') as OutcomeKind;
      if (URGENT_THREE.includes(kind)) {
        expect(hasUrgentBorder(rowEl)).toBe(true);
      } else {
        expect(hasUrgentBorder(rowEl)).toBe(false);
      }
    }
  });

  it("'running' has its own left-border+tint treatment, distinct from the urgent three", () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    const runningRow = screen
      .getAllByTestId('run-row')
      .find((el) => el.getAttribute('data-outcome-kind') === 'running');
    expect(runningRow).toBeDefined();
    expect(runningRow?.className).toMatch(/\bborder-l-primary\b/);
    expect(hasUrgentBorder(runningRow as Element)).toBe(false);
  });

  it("(b) the greyscale test: every row's accessible text alone distinguishes it from every other row", () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    const texts = screen
      .getAllByTestId('run-row')
      .map((el) => el.textContent?.trim() ?? '');

    expect(texts).toHaveLength(7);
    expect(new Set(texts).size).toBe(7);
  });

  it('every kind renders its own redundant text label (ux-notes §1 Label column)', () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    const labels = screen.getAllByTestId('run-row-label').map((el) => el.textContent);
    expect(labels).toEqual([
      'New jobs on your board',
      'Ran clean',
      'Ran with warnings',
      'Failed at `structure`',
      'Lost contact',
      'Running — `structure` 5/10',
      'Telemetry missing',
    ]);
  });

  it('farm-safe subline: the calm-empty row reads its scraped count from source, never a literal 0 from farm', () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    const subline = screen.getByTestId('run-row-subline');
    expect(subline.textContent).toBe('10/10 stages · 214 scraped, 0 passed filter');
    expect(subline.textContent).not.toMatch(/0 scraped/);
    expect(subline.textContent).not.toMatch(/farm/i);
  });

  it('unrecorded and failed/crashed number slots read `—`, never a literal 0', () => {
    render(<RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />);
    const numbers = new Map(
      screen
        .getAllByTestId('run-row')
        .map((el) => [
          el.getAttribute('data-outcome-kind'),
          el.querySelector('[data-testid="run-row-number"]')?.textContent,
        ]),
    );
    expect(numbers.get('failed')).toBe('—');
    expect(numbers.get('crashed')).toBe('—');
    expect(numbers.get('unrecorded')).toBe('—');
    expect(numbers.get('produced')).toBe('7');
    expect(numbers.get('empty')).toBe('0');
  });
});

// `RunsPage.tsx`'s `/api/profiles/:name/runs` list fetch only ever returns
// bare `RunSummary` rows (no `result`/`failure`) — RunsPage hydrates
// passed/crashed rows with fetched `RunDetail` before handing them to this
// component (see RunsPage.test.tsx's own regression test for that
// integration), but while a hydration fetch is still in flight — or for any
// other bare-`RunSummary` caller — `RunsList` genuinely does receive rows
// shaped exactly like these fixtures. `classifyOutcome` (B13,
// runOutcome.ts) documents its own fail-safe for this case: a bare
// `RunSummary` can never resolve 'unrecorded' (falls to generic 'crashed')
// and never resolves 'produced'/'empty' for a 'passed' row (falls to
// 'degraded'). These tests make that documented fallback visible in this
// component's own suite, per this fix round's [important] finding, rather
// than only ever being exercised through RunDetail-shaped fixtures that the
// real API never actually serves at list scope.
const BARE_SUMMARY_BASE = {
  date: '2026-08-05',
  timeDir: '09-00',
  kind: 'run' as const,
  resumedFrom: null,
  startedAt: '2026-08-05T09:00:00.000Z',
  finishedAt: '2026-08-05T09:05:00.000Z',
  heartbeatAt: '2026-08-05T09:05:00.000Z',
  progress: null,
  catchupSlots: null,
};

describe('RunsList — bare RunSummary rows (the real /runs list contract)', () => {
  it('a bare "passed" RunSummary — no result to read jobsOut/health from — fails safe to degraded, never produced/empty', () => {
    const row: RunSummary = { id: 20, ...BARE_SUMMARY_BASE, status: 'passed' };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'degraded');
    expect(rowEl).toHaveTextContent('Ran with warnings');
  });

  it('a bare "crashed" RunSummary — no result/failure to confirm the A6 unrecorded shape — falls to generic crashed, never unrecorded', () => {
    const row: RunSummary = { id: 21, ...BARE_SUMMARY_BASE, status: 'crashed' };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'crashed');
    expect(rowEl).toHaveTextContent('Lost contact');
  });
});

// Fix-round finding #4: `RunsList` used to classify every row via
// `classifyOutcome(row, undefined)` — the list NEVER had a real
// `SoftErrorSummary` to pass, even for a full `RunDetail` row with all 10
// stages recorded, so a soft-error-driven (or breaker-driven) degraded run
// always rendered as calm 'Ran clean' at list scope. This fixture is the
// one case the ORIGINAL 7-fixture set above genuinely lacks: all 10 stages
// present (so the stage-count health-gate check alone can't explain
// 'degraded'), zero yield, health failing ONLY because of the attached
// `softErrors`.
describe('RunsList — soft-error-driven degraded row (fix-round finding #4)', () => {
  it('a full RunDetail row with all 10 stages, zero yield, and softErrors over threshold classifies degraded, not empty', () => {
    const softErrors: SoftErrorSummary = { total: 12, groups: [], breakerOpen: false };
    const row: RunDetail & { softErrors: SoftErrorSummary } = {
      id: 30,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 0) },
      failure: null,
      syncDryrun: null,
      softErrors,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'degraded');
    expect(rowEl).toHaveTextContent('Ran with warnings');
  });

  it('the SAME row shape with breakerOpen instead of a high total also classifies degraded, not empty', () => {
    const softErrors: SoftErrorSummary = { total: 1, groups: [], breakerOpen: true };
    const row: RunDetail & { softErrors: SoftErrorSummary } = {
      id: 31,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 0) },
      failure: null,
      syncDryrun: null,
      softErrors,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'degraded');
  });

  it('the same row WITHOUT softErrors attached (undefined) still classifies empty — proves the row-level softErrors is what changed the verdict, not the fixture shape', () => {
    const row: RunDetail = {
      id: 32,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 0) },
      failure: null,
      syncDryrun: null,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'empty');
  });
});

// This task's fix: `RunsList` used to render a subline ONLY for `'empty'`
// rows (`emptySubline`) — a `'degraded'` row rendered no subline at all,
// silently dropping the soft-error count that is exactly what makes the row
// urgent in the first place. `row.softErrors` is the same hydration input
// `classifyOutcome` already reads to reach `'degraded'` (fix-round finding
// #4 above), so this reuses that same attached field rather than a new
// per-row fetch.
describe('RunsList — degraded row soft-error-count subline', () => {
  it('a degraded row with softErrors.total 8 renders "8 soft errors"', () => {
    const softErrors: SoftErrorSummary = { total: 8, groups: [], breakerOpen: false };
    const row: RunDetail & { softErrors: SoftErrorSummary } = {
      id: 40,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 0) },
      failure: null,
      syncDryrun: null,
      softErrors,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'degraded');
    expect(screen.getByTestId('run-row-subline')).toHaveTextContent('8 soft errors');
  });

  it('a degraded row with softErrors.total 1 renders the singular "1 soft error"', () => {
    const softErrors: SoftErrorSummary = { total: 1, groups: [], breakerOpen: true };
    const row: RunDetail & { softErrors: SoftErrorSummary } = {
      id: 41,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 0) },
      failure: null,
      syncDryrun: null,
      softErrors,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByTestId('run-row-subline')).toHaveTextContent('1 soft error');
    expect(screen.getByTestId('run-row-subline')).not.toHaveTextContent('1 soft errors');
  });

  it('a degraded row with no softErrors attached (still loading) renders no subline at all', () => {
    const row: RunDetail = {
      id: 42,
      ...BASE,
      status: 'passed',
      result: { stages: stages(9, 0) }, // missing-stage-count degraded — no softErrors needed
      failure: null,
      syncDryrun: null,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-outcome-kind', 'degraded');
    expect(screen.queryByTestId('run-row-subline')).not.toBeInTheDocument();
  });
});

// Task 25 (blueprint.md step 1.5): a catch-up run's badge + subline
// override, layered on top of a normally-classified `produced` row —
// `catchupSlots` is orthogonal to `OutcomeKind` (design-scale.md), so these
// fixtures deliberately reuse the plain `produced` shape and vary only
// `catchupSlots`.
describe('RunsList — catch-up row extension (blueprint.md 1.5)', () => {
  it('a produced row with catchupSlots renders the "Catch-up" badge and the "Stood in for N slots" subline verbatim', () => {
    const row: RunDetail = {
      id: 50,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 7) },
      failure: null,
      syncDryrun: null,
      catchupSlots: ['14:00', '16:30', '19:00'],
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).toHaveAttribute('data-qa', 'run-row-catchup');
    expect(screen.getByText('Catch-up')).toBeInTheDocument();
    expect(screen.getByText('Stood in for 3 slots')).toBeInTheDocument();
  });

  it('the same row shape with catchupSlots: null renders neither the badge nor the overridden subline', () => {
    const row: RunDetail = {
      id: 51,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 7) },
      failure: null,
      syncDryrun: null,
      catchupSlots: null,
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    const rowEl = screen.getByTestId('run-row');
    expect(rowEl).not.toHaveAttribute('data-qa', 'run-row-catchup');
    expect(screen.queryByText('Catch-up')).not.toBeInTheDocument();
    expect(screen.queryByText(/Stood in for/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-row-subline')).not.toBeInTheDocument();
  });

  it('a singular catch-up count renders "Stood in for 1 slot" with no trailing "s"', () => {
    const row: RunDetail = {
      id: 52,
      ...BASE,
      status: 'passed',
      result: { stages: stages(10, 7) },
      failure: null,
      syncDryrun: null,
      catchupSlots: ['14:00'],
    };
    render(<RunsList rows={[row]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('Stood in for 1 slot')).toBeInTheDocument();
    expect(screen.queryByText('Stood in for 1 slots')).not.toBeInTheDocument();
  });
});

// BUG 10 (pipeline-stability-hardening QA round 3, 2026-08-14) — ux-notes.md
// §9 verbatim: "it must not enter the runs listbox." `insertContent` used to
// render inside `role="listbox"`, between two `role="option"` rows: a div
// holding a paragraph/region/heading/button is not a permitted listbox
// child (ARIA 1.2 requires only `option`, or `group` of `option`s), and AT
// that prunes disallowed children drops the whole group from the
// accessibility tree. `INSERT_FIXTURE` below reproduces the QA report's own
// driven evidence shape (`text`, `paragraph`, `region`, `heading[level=3]`,
// `button`) so the standing guard exercises the exact tree that was found
// broken, not a simplified stand-in.
const INSERT_FIXTURE = (
  <div data-testid="fixture-insert">
    <p>Job Bunny declined to start these runs because the host was asleep.</p>
    <section aria-label="Details">09:00 · host asleep</section>
    <h3>Details</h3>
    <button type="button">Details</button>
  </div>
);

describe('RunsList — accessibility: the inserted group must not enter role="listbox" (BUG 10)', () => {
  it('STANDING GUARD: every role="listbox" contains ONLY role="option" children, even with content inserted mid-list', () => {
    const { container } = render(
      <RunsList
        rows={ROWS}
        selectedId={null}
        onSelect={() => {}}
        insertAfterId={3}
        insertContent={INSERT_FIXTURE}
      />,
    );
    const nonOptionChildren = container.querySelectorAll(
      '[role="listbox"] > *:not([role="option"])',
    );
    expect(nonOptionChildren).toHaveLength(0);
  });

  it('STANDING GUARD: also holds with no insertion at all (the plain single-listbox case)', () => {
    const { container } = render(
      <RunsList rows={ROWS} selectedId={null} onSelect={() => {}} />,
    );
    const nonOptionChildren = container.querySelectorAll(
      '[role="listbox"] > *:not([role="option"])',
    );
    expect(nonOptionChildren).toHaveLength(0);
  });

  it('STANDING GUARD: also holds when insertAfterId matches no row (degrades to a single listbox, nothing inserted)', () => {
    const { container } = render(
      <RunsList
        rows={ROWS}
        selectedId={null}
        onSelect={() => {}}
        insertAfterId={999}
        insertContent={INSERT_FIXTURE}
      />,
    );
    expect(screen.queryByTestId('fixture-insert')).not.toBeInTheDocument();
    const nonOptionChildren = container.querySelectorAll(
      '[role="listbox"] > *:not([role="option"])',
    );
    expect(nonOptionChildren).toHaveLength(0);
    expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(1);
  });

  it('the inserted content is not a DESCENDANT of any listbox either (not just not a direct child)', () => {
    const { container } = render(
      <RunsList
        rows={ROWS}
        selectedId={null}
        onSelect={() => {}}
        insertAfterId={3}
        insertContent={INSERT_FIXTURE}
      />,
    );
    const insert = container.querySelector('[data-testid="fixture-insert"]');
    expect(insert).not.toBeNull();
    expect(insert?.closest('[role="listbox"]')).toBeNull();
  });

  it('splits into two listboxes with DISTINCT, non-empty accessible names — never two identically-named "Runs" lists', () => {
    render(
      <RunsList
        rows={ROWS}
        selectedId={null}
        onSelect={() => {}}
        insertAfterId={3}
        insertContent={INSERT_FIXTURE}
      />,
    );
    const listboxes = screen.getAllByRole('listbox');
    expect(listboxes).toHaveLength(2);
    const names = listboxes.map((el) => el.getAttribute('aria-label'));
    expect(names[0]).toBeTruthy();
    expect(names[1]).toBeTruthy();
    expect(names[0]).not.toBe(names[1]);
  });

  it('document order: rows-before -> insertContent -> rows-after, with more than one row on each side', () => {
    const { container } = render(
      <RunsList
        rows={ROWS}
        selectedId={null}
        onSelect={() => {}}
        insertAfterId={3}
        insertContent={INSERT_FIXTURE}
      />,
    );
    const runIds = screen
      .getAllByTestId('run-row')
      .map((el) => el.getAttribute('data-run-id'));
    // Row order itself is untouched by the split (ids 1..7, unchanged).
    expect(runIds).toEqual(['1', '2', '3', '4', '5', '6', '7']);

    const lastBeforeRow = container.querySelector('[data-run-id="3"]') as HTMLElement;
    const insert = container.querySelector(
      '[data-testid="fixture-insert"]',
    ) as HTMLElement;
    const firstAfterRow = container.querySelector('[data-run-id="4"]') as HTMLElement;

    // DOCUMENT_POSITION_FOLLOWING on the comparison target means the
    // target comes AFTER the node compareDocumentPosition was called on.
    expect(
      lastBeforeRow.compareDocumentPosition(insert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      insert.compareDocumentPosition(firstAfterRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
