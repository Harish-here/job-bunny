import { describe, expect, it } from 'vitest';
import type { RunDetail, RunSummary, SoftErrorSummary } from '../../lib/api/types';
import { classifyFailure, runRegistry } from './runDiagnosis';

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

const EMPTY_SOFT_ERRORS: SoftErrorSummary = { total: 0, groups: [] };

const BREAKER_OPEN_SOFT_ERRORS: SoftErrorSummary = {
  total: 1,
  groups: [
    {
      key: 'unknown',
      label: 'unknown: uncategorized soft error',
      count: 1,
      sample:
        'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
    },
  ],
};

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
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict.kind).toBe('stall');
    expect(verdict.title).toContain('farm');
    expect(verdict.title).toContain('6 minute');
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
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict.kind).toBe('total-outage');
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
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict.kind).toBe('expired-login');
    expect(verdict.title).toContain('LinkedIn login has expired');
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
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict.kind).toBe('total-outage');
  });

  it("'zero-yield-healthy' — delegates to B13's health gate (all 10 stages, no failure, no breaker, low soft-error count)", () => {
    const run = detail({
      status: 'passed',
      result: { stages: stages(10, 0, { locations: 189 }) },
    });
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict.kind).toBe('zero-yield-healthy');
    expect(verdict.title).toContain('filter');
    expect(verdict.title).toContain('locations');
  });

  it("'breaker-open' — a breaker-open soft-error group is present (blueprint §7 exact warn message)", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error: 'some other unrelated failure text',
        elapsedMs: 1000,
      },
    });
    const verdict = classifyFailure(run, BREAKER_OPEN_SOFT_ERRORS);
    expect(verdict.kind).toBe('breaker-open');
  });

  it("'chrome-not-found' — failure.error contains the launcher.ts exact substring", () => {
    const run = detail({
      status: 'failed',
      failure: {
        stage: 'farm',
        error:
          'no Chrome executable found (checked: /a, /b) — install Google Chrome (or Microsoft Edge on Windows)',
        elapsedMs: 1000,
      },
    });
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict.kind).toBe('chrome-not-found');
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
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
    expect(verdict).toEqual({
      kind: 'fallback',
      title: 'Failed at `structure`',
      nextAction: 'Run again',
      rawError: 'llm request timed out after 3 retries',
      lastCheckpoint: '09-00',
    });
  });

  it("'fallback' — no lastCheckpoint on the failure blob leaves it undefined, not invented", () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'assemble', error: 'unexpected shape', elapsedMs: 1000 },
    });
    const verdict = classifyFailure(run, EMPTY_SOFT_ERRORS);
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
    const stubEntry = {
      kind: 'stub-test-class' as never,
      matches: () => true,
      title: () => 't',
      nextAction: () => 'n',
    };
    const verdict = runRegistry([stubEntry], run, EMPTY_SOFT_ERRORS);
    expect(verdict).toEqual({ kind: 'stub-test-class', title: 't', nextAction: 'n' });
  });

  it('an entry earlier in array order wins over a later one that would also match', () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'sync', error: 'anything at all', elapsedMs: 1000 },
    });
    const first = {
      kind: 'stub-a' as never,
      matches: () => true,
      title: () => 'a',
      nextAction: () => 'a',
    };
    const second = {
      kind: 'stub-b' as never,
      matches: () => true,
      title: () => 'b',
      nextAction: () => 'b',
    };
    const verdict = runRegistry([first, second], run, EMPTY_SOFT_ERRORS);
    expect(verdict?.kind).toBe('stub-a');
  });

  it('an empty registry (no match) returns null, leaving classifyFailure to build the fallback', () => {
    const run = detail({
      status: 'failed',
      failure: { stage: 'sync', error: 'anything at all', elapsedMs: 1000 },
    });
    expect(runRegistry([], run, EMPTY_SOFT_ERRORS)).toBeNull();
  });
});
