import { describe, expect, it } from 'vitest';
import type { RunEventRow, RunSummary } from '../../lib/api/types';
import {
  heartbeatFreshness,
  parseStageProgress,
  RUN_HEARTBEAT_STALE_MS,
  STAGE_ORDER,
} from './runProgress';

function event(msg: string): RunEventRow {
  return { ts: '2026-08-08T09:00:00.000Z', level: 'info', msg };
}

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

describe('parseStageProgress', () => {
  it('returns null for no events', () => {
    expect(parseStageProgress([])).toBeNull();
  });

  it('returns null when no message has a stage prefix', () => {
    expect(
      parseStageProgress([event('daemon: tick'), event('notify: sending digest')]),
    ).toBeNull();
  });

  it('a single reconcile: starting maps to index 1', () => {
    expect(parseStageProgress([event('reconcile: starting')])).toEqual({
      stage: 'reconcile',
      index: 1,
      total: 10,
    });
  });

  it('the LAST matching prefix wins even when earlier ones exist', () => {
    const events = [
      event('reconcile: starting'),
      event('farm: starting'),
      event('structure: starting'),
      event('source: retry'),
    ];
    expect(parseStageProgress(events)?.stage).toBe('source');
  });

  it('a message whose prefix is not in STAGE_ORDER is ignored', () => {
    const events = [event('filter: starting'), event('notify: sending digest')];
    expect(parseStageProgress(events)).toEqual({ stage: 'filter', index: 7, total: 10 });
  });

  it('sync: done maps to index 10, total 10', () => {
    expect(parseStageProgress([event('sync: done')])).toEqual({
      stage: 'sync',
      index: 10,
      total: 10,
    });
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
