import { describe, expect, it } from 'vitest';
import type {
  RunDetail,
  RunEventRow,
  RunSummary,
  SoftErrorSummary,
} from '../../lib/api/types';
import {
  classifyFailure,
  type DiagnosisEntry,
  type DiagnosisInput,
  runRegistry,
} from './runDiagnosis';

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

function stages(
  count: number,
  lastJobsOut: number,
  dropsByRule: Record<string, number> = {},
) {
  return STAGE_NAMES.slice(0, count).map((name, i) => ({
    name,
    jobsIn: 10,
    jobsOut: i === count - 1 ? lastJobsOut : 10,
    dropsByRule: i === count - 1 ? dropsByRule : {},
    elapsedMs: 100,
    attempts: 1,
  }));
}

const BASE_SUMMARY: Omit<RunSummary, 'status'> = {
  id: 1,
  date: '2026-08-05',
  timeDir: '09-00',
  kind: 'run',
  resumedFrom: null,
  startedAt: '2026-08-05T09:00:00.000Z',
  finishedAt: '2026-08-05T09:05:00.000Z',
  heartbeatAt: '2026-08-05T09:05:00.000Z',
  progress: null,
  catchupSlots: null,
};

function detail(overrides: {
  status: RunSummary['status'];
  result?: unknown;
  failure?: unknown;
}): RunDetail {
  return {
    ...BASE_SUMMARY,
    status: overrides.status,
    result: overrides.result ?? null,
    failure: overrides.failure ?? null,
    syncDryrun: null,
  };
}

const EMPTY_SOFT_ERRORS: SoftErrorSummary = {
  total: 0,
  groups: [],
  breakerOpen: false,
  capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
};

// The real shape `groupSoftErrors` returns: `breakerOpen` is a first-class
// field, never inferred from a group's `sample` (fix-round finding #3) —
// see `runOutcome.test.ts`'s own fixture comment for the full rationale.
const BREAKER_OPEN_SOFT_ERRORS: SoftErrorSummary = {
  total: 1,
  groups: [
    {
      key: 'farm',
      label: 'farm: uncategorized soft error',
      count: 1,
      sample:
        'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
    },
  ],
  breakerOpen: true,
  capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
};

// The real producer shape (src/adapters/lanes/linkedin/lane.ts:154-157).
const BREAKER_OPEN_EVENT: RunEventRow = {
  ts: '2026-08-11T21:00:00.000Z',
  level: 'warn',
  msg: 'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
  data: { reopenAt: '2026-08-11T21:40:00.000Z', tripCount: 12 },
};

function input(overrides: {
  run: RunDetail;
  softErrors?: SoftErrorSummary;
  events?: RunEventRow[];
  profile?: string;
}): DiagnosisInput {
  return {
    run: overrides.run,
    softErrors: overrides.softErrors ?? EMPTY_SOFT_ERRORS,
    events: overrides.events,
    profile: overrides.profile ?? 'rajni',
  };
}

describe('classifyFailure', () => {
  it("'stall' — failure.error carries the guard.ts stall message shape (plan.md A4, 2 of 4 corpus failures)", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error: 'stage "farm" stalled: no beat() within 360000ms',
        elapsedMs: 360000,
      },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('stall');
    expect(verdict.title).toContain('farm');
    expect(verdict.title).toContain('6 minute');
    expect(verdict.action).toEqual({ kind: 'run', label: 'Run again' });
    expect(verdict.secondaryAction).toEqual({
      kind: 'reveal',
      label: 'Show full log',
      target: 'events',
    });
  });

  it("'total-outage' — failure.error matches 'total outage' (1 of 4 corpus failures)", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error:
          'farm stage: all 1 farming lane(s) failed this run — total outage, not one broken lane',
        elapsedMs: 5000,
      },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('total-outage');
    expect(verdict.action).toEqual({ kind: 'run', label: 'Run again' });
    expect(verdict.secondaryAction).toEqual({
      kind: 'reveal',
      label: 'Show full log',
      target: 'events',
    });
  });

  it("'expired-login' — failure.stage === 'source' and error matches the all-urls-failed pattern, unambiguous (no total-outage overlap)", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'source',
        error:
          'linkedin lane: all 6 attempted url(s) failed this run. No further evidence.',
        elapsedMs: 5000,
      },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('expired-login');
    expect(verdict.title).toContain('LinkedIn login has expired');
    expect(verdict.action).toEqual({ kind: 'run', label: 'Run again' });
    expect(verdict.secondaryAction).toEqual({
      kind: 'reveal',
      label: 'Show the 6 failed URLs',
      target: 'events',
    });
  });

  it("expired-login does NOT outrank total-outage when a fixture's error matches BOTH patterns (plan.md's explicit ordering constraint)", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'source',
        error:
          'linkedin lane: all 3 attempted url(s) failed this run. total outage, not one broken lane.',
        elapsedMs: 5000,
      },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('total-outage');
  });

  it("'zero-yield-healthy' — delegates to B13's health gate (all 10 stages, no failure, no breaker, low soft-error count)", () => {
    const run = detail({
      status: 'passed',
      result: { stages: stages(10, 0, { locations: 189 }) },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('zero-yield-healthy');
    expect(verdict.title).toContain('filter');
    expect(verdict.title).toContain('locations');
    expect(verdict.action).toEqual({
      kind: 'navigate',
      label: 'Review filter rules →',
      route: { name: 'settings', section: 'filters' },
    });
    expect(verdict.secondaryAction).toBeUndefined();
  });

  it("'breaker-open' — a breaker-open soft-error group is present (blueprint §7 exact warn message), disabled 'run again' with retryAt read from events", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error: 'some other unrelated failure text',
        elapsedMs: 1000,
      },
    });
    const verdict = classifyFailure(
      input({ run, softErrors: BREAKER_OPEN_SOFT_ERRORS, events: [BREAKER_OPEN_EVENT] }),
    );
    expect(verdict.kind).toBe('breaker-open');
    expect(verdict.action).toEqual({
      kind: 'run',
      label: 'Run again',
      disabled: true,
      retryAt: '2026-08-11T21:40:00.000Z',
    });
    expect(verdict.secondaryAction).toEqual({
      kind: 'reveal',
      label: 'Show full log',
      target: 'events',
    });
  });

  it("'breaker-open' — retryAt is omitted (never invented) when no events carry the breaker warn", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error: 'some other unrelated failure text',
        elapsedMs: 1000,
      },
    });
    const verdict = classifyFailure(input({ run, softErrors: BREAKER_OPEN_SOFT_ERRORS }));
    expect(verdict.kind).toBe('breaker-open');
    expect(verdict.action).toEqual({ kind: 'run', label: 'Run again', disabled: true });
    expect((verdict.action as { retryAt?: string }).retryAt).toBeUndefined();
  });

  it("'degraded' — a status:'passed' run with fewer than 10 recorded stages (fix-round finding #2, the exact fixture RunsList.test.tsx uses: 9 stages, zero yield)", () => {
    const run = detail({ status: 'passed', result: { stages: stages(9, 0) } });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('degraded');
    expect(verdict.title).toContain('9 of 10');
    expect(verdict.title).not.toContain('Failed');
    expect(verdict.action).toEqual({
      kind: 'reveal',
      label: 'Review run events',
      target: 'events',
    });
    expect(verdict.secondaryAction).toBeUndefined();
  });

  it("'degraded' — a status:'passed' run with all 10 stages but a high soft-error count (fix-round finding #2)", () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
    const softErrors: SoftErrorSummary = {
      total: 12,
      groups: [],
      breakerOpen: false,
      capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
    };
    const verdict = classifyFailure(input({ run, softErrors }));
    expect(verdict.kind).toBe('degraded');
    expect(verdict.title).toContain('12 soft errors');
  });

  it("'breaker-open' still outranks the generic 'degraded' entry when a zero-yield passed run's health gate fails specifically due to the breaker", () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
    const verdict = classifyFailure(input({ run, softErrors: BREAKER_OPEN_SOFT_ERRORS }));
    expect(verdict.kind).toBe('breaker-open');
  });

  it("'chrome-not-found' — failure.error contains the launcher.ts exact substring, copy action interpolates the real profile", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error:
          'no Chrome executable found (checked: /a, /b) — install Google Chrome (or Microsoft Edge on Windows)',
        elapsedMs: 1000,
      },
    });
    const verdict = classifyFailure(input({ run, profile: 'rajni' }));
    expect(verdict.kind).toBe('chrome-not-found');
    expect(verdict.action).toEqual({
      kind: 'copy',
      label: 'Copy: jobbunny doctor --profile rajni',
      command: 'jobbunny doctor --profile rajni',
    });
    expect(verdict.secondaryAction).toEqual({
      kind: 'reveal',
      label: 'Show full log',
      target: 'events',
    });
  });

  it("'fallback' — an unmatched failure shape falls through with no invented kind (spec AC11)", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'structure',
        error: 'llm request timed out after 3 retries',
        elapsedMs: 9000,
        lastCheckpoint: '09-00',
      },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict).toEqual({
      kind: 'fallback',
      title: 'Failed at `structure`',
      action: { kind: 'run', label: 'Run again' },
      secondaryAction: { kind: 'reveal', label: 'Show full log', target: 'events' },
      rawError: 'llm request timed out after 3 retries',
      lastCheckpoint: '09-00',
    });
  });

  it("'fallback' — no lastCheckpoint on the failure blob leaves it undefined, not invented", () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'assemble', error: 'unexpected shape', elapsedMs: 1000 },
    });
    const verdict = classifyFailure(input({ run }));
    expect(verdict.kind).toBe('fallback');
    expect(verdict.lastCheckpoint).toBeUndefined();
  });
});

describe('runRegistry — A5 registry-extensibility (adding a class costs one entry, zero signature changes)', () => {
  it('a stub entry pushed onto a copy of the array is picked up by the same iteration function classifyFailure uses', () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'sync', error: 'anything at all', elapsedMs: 1000 },
    });
    const stubEntry: DiagnosisEntry = {
      kind: 'stub-test-class' as never,
      matches: () => true,
      title: () => 't',
      action: () => ({ kind: 'run', label: 'n' }),
    };
    const verdict = runRegistry([stubEntry], input({ run }));
    expect(verdict).toEqual({
      kind: 'stub-test-class',
      title: 't',
      action: { kind: 'run', label: 'n' },
      secondaryAction: undefined,
    });
  });

  it('an entry earlier in array order wins over a later one that would also match', () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'sync', error: 'anything at all', elapsedMs: 1000 },
    });
    const first: DiagnosisEntry = {
      kind: 'stub-a' as never,
      matches: () => true,
      title: () => 'a',
      action: () => ({ kind: 'run', label: 'a' }),
    };
    const second: DiagnosisEntry = {
      kind: 'stub-b' as never,
      matches: () => true,
      title: () => 'b',
      action: () => ({ kind: 'run', label: 'b' }),
    };
    const verdict = runRegistry([first, second], input({ run }));
    expect(verdict?.kind).toBe('stub-a');
  });

  it('an empty registry (no match) returns null, leaving classifyFailure to build the fallback', () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'sync', error: 'anything at all', elapsedMs: 1000 },
    });
    expect(runRegistry([], input({ run }))).toBeNull();
  });
});
