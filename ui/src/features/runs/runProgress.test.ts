import { describe, expect, it } from 'vitest';
import type { RunProgress, RunSummary } from '../../lib/api/types';
import {
  heartbeatFreshness,
  RUN_HEARTBEAT_STALE_MS,
  STAGE_ORDER,
  stageProgressFrom,
} from './runProgress';

function makeRun(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 1,
    date: '2026-08-08',
    timeDir: '10-00',
    kind: 'run',
    resumedFrom: null,
    status: 'running',
    startedAt: '2026-08-08T09:50:00.000Z',
    finishedAt: null,
    heartbeatAt: null,
    progress: null,
    ...over,
  };
}

describe('STAGE_ORDER', () => {
  it('is the frozen 10-stage pipeline order', () => {
    expect(STAGE_ORDER).toEqual([
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
    ]);
  });
});

describe('stageProgressFrom', () => {
  it('returns run.progress unchanged when it is populated', () => {
    const progress: RunProgress = {
      stage: 'filter',
      stageIndex: 7,
      stageTotal: 10,
      stageStartedAt: '2026-08-08T09:00:00.000Z',
      updatedAt: '2026-08-08T09:05:00.000Z',
      itemCurrent: null,
      itemTotal: null,
    };
    expect(stageProgressFrom(makeRun({ progress }))).toBe(progress);
  });

  it('returns null when run.progress is null', () => {
    expect(stageProgressFrom(makeRun({ progress: null }))).toBeNull();
  });
});

describe('heartbeatFreshness', () => {
  const NOW = Date.parse('2026-08-08T10:00:00.000Z');

  it('is unknown when heartbeatAt is null', () => {
    expect(heartbeatFreshness(makeRun({ heartbeatAt: null }), NOW)).toBe('unknown');
  });

  it('is fresh well within the stale window', () => {
    const heartbeatAt = new Date(NOW - 60_000).toISOString();
    expect(heartbeatFreshness(makeRun({ heartbeatAt }), NOW)).toBe('fresh');
  });

  it('is fresh exactly at the stale boundary', () => {
    const heartbeatAt = new Date(NOW - RUN_HEARTBEAT_STALE_MS).toISOString();
    expect(heartbeatFreshness(makeRun({ heartbeatAt }), NOW)).toBe('fresh');
  });

  it('is stale just past the boundary', () => {
    const heartbeatAt = new Date(NOW - RUN_HEARTBEAT_STALE_MS - 1000).toISOString();
    expect(heartbeatFreshness(makeRun({ heartbeatAt }), NOW)).toBe('stale');
  });
});
