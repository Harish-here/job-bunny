import { describe, expect, it } from 'vitest';
import type { RunDetail, RunSummary, SoftErrorSummary } from '../../lib/api/types';
import { classifyOutcome, SOFT_ERROR_RATE_THRESHOLD } from './runOutcome';

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

const EMPTY_SOFT_ERRORS: SoftErrorSummary = { total: 0, groups: [], breakerOpen: false };

// The real shape `groupSoftErrors` (app/features/runs/soft_errors.ts)
// returns: `breakerOpen` is a FIRST-CLASS field computed by scanning every
// raw event's msg, never inferred from a group's `sample` — the breaker
// warn is frequently bucketed under the same 'farm' scope key as unrelated
// warns, so its text is often NOT the group sample at all (fix-round
// finding #3).
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
};

describe('classifyOutcome', () => {
  it("'running' — status is running", () => {
    const run: RunSummary = { ...BASE_SUMMARY, status: 'running', finishedAt: null };
    expect(classifyOutcome(run, undefined)).toBe('running');
  });

  it("'unrecorded' — status crashed with BOTH result and failure null (A6: the real DB row shape)", () => {
    const run = detail({ status: 'crashed', result: null, failure: null });
    expect(classifyOutcome(run, undefined)).toBe('unrecorded');
  });

  it("'crashed' — status crashed with a non-null failure blob (not the unrecorded shape)", () => {
    const run = detail({
      status: 'crashed',
      result: null,
      failure: { stage: 'source', error: 'lost contact', elapsedMs: 1000 },
    });
    expect(classifyOutcome(run, undefined)).toBe('crashed');
  });

  it("'crashed' — status crashed with a non-null result blob (failure still null)", () => {
    const run = detail({
      status: 'crashed',
      result: { stages: stages(10, 0) },
      failure: null,
    });
    expect(classifyOutcome(run, undefined)).toBe('crashed');
  });

  it("'crashed' — bare RunSummary can never be decided as unrecorded (no result/failure to inspect)", () => {
    const run: RunSummary = { ...BASE_SUMMARY, status: 'crashed' };
    expect(classifyOutcome(run, undefined)).toBe('crashed');
  });

  it("'failed' — status failed", () => {
    const run = detail({
      status: 'failed',
      result: null,
      failure: { stage: 'structure', error: 'boom', elapsedMs: 500 },
    });
    expect(classifyOutcome(run, undefined)).toBe('failed');
  });

  it("'produced' — passed with a positive last-stage jobsOut", () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 7) } });
    expect(classifyOutcome(run, EMPTY_SOFT_ERRORS)).toBe('produced');
  });

  it("'empty' — zero-yield passed run that clears the health gate (AC3: the healthy half)", () => {
    const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
    expect(classifyOutcome(run, EMPTY_SOFT_ERRORS)).toBe('empty');
  });

  describe("'degraded' — same zero-yield shape as 'empty' but the health gate fails (AC3: the unhealthy half)", () => {
    it('fewer than 10 stages recorded', () => {
      const run = detail({ status: 'passed', result: { stages: stages(9, 0) } });
      expect(classifyOutcome(run, EMPTY_SOFT_ERRORS)).toBe('degraded');
    });

    it('breakerOpen is true (fix-round finding #3: a first-class flag, not group.sample matching)', () => {
      const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
      expect(classifyOutcome(run, BREAKER_OPEN_SOFT_ERRORS)).toBe('degraded');
    });

    it('breakerOpen is true even when no group.sample contains the breaker text at all (real ScopedLogger bucketing: the breaker warn landed in a group whose FIRST/sample event was unrelated)', () => {
      const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
      const softErrors: SoftErrorSummary = {
        total: 2,
        groups: [
          {
            key: 'farm',
            label: 'farm: uncategorized soft error',
            count: 2,
            sample: 'linkedin lane: page identity loss', // NOT the breaker text
          },
        ],
        breakerOpen: true,
      };
      expect(classifyOutcome(run, softErrors)).toBe('degraded');
    });

    it('soft-error rate is at/above threshold', () => {
      const run = detail({ status: 'passed', result: { stages: stages(10, 0) } });
      const softErrors: SoftErrorSummary = {
        total: SOFT_ERROR_RATE_THRESHOLD,
        groups: [],
        breakerOpen: false,
      };
      expect(classifyOutcome(run, softErrors)).toBe('degraded');
    });
  });

  it("'degraded' — bare RunSummary status passed (no funnel to read) fails safe rather than defaulting calm", () => {
    const run: RunSummary = { ...BASE_SUMMARY, status: 'passed' };
    expect(classifyOutcome(run, EMPTY_SOFT_ERRORS)).toBe('degraded');
  });
});
