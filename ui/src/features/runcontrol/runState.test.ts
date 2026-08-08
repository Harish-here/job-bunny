import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../../lib/api/types';
import type { RunIntentView } from '../wizard/wizard.types';
import { DONE_WINDOW_MS, pickRunControlState, runControlLabel } from './runState';

const NOW = Date.parse('2026-08-08T10:00:00.000Z');
const WITHIN = new Date(NOW - 5 * 60 * 1000).toISOString(); // 5 min ago
const AT_BOUNDARY = new Date(NOW - DONE_WINDOW_MS).toISOString(); // exactly 10 min ago
const OUTSIDE = new Date(NOW - DONE_WINDOW_MS - 1000).toISOString(); // just past the window

function makeRun(
  over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'status'>,
): RunSummary {
  return {
    date: '2026-08-08',
    timeDir: '10-00',
    kind: 'run',
    resumedFrom: null,
    startedAt: '2026-08-08T09:50:00.000Z',
    finishedAt: null,
    heartbeatAt: null,
    ...over,
  };
}

function makeIntent(
  over: Partial<RunIntentView> & Pick<RunIntentView, 'id' | 'status'>,
): RunIntentView {
  return {
    requestedAt: '2026-08-08T09:00:00.000Z',
    claimedRunId: null,
    ...over,
  };
}

function baseInput(over: Partial<Parameters<typeof pickRunControlState>[0]> = {}) {
  return {
    runs: [],
    intents: [],
    newestResult: undefined,
    progress: null,
    conflictRunId: null,
    now: NOW,
    ...over,
  };
}

describe('pickRunControlState precedence', () => {
  it('running beats a conflict, a queued intent, and a fresh passed run', () => {
    const state = pickRunControlState(
      baseInput({
        runs: [
          makeRun({ id: 2, status: 'running' }),
          makeRun({ id: 1, status: 'passed', finishedAt: WITHIN }),
        ],
        intents: [makeIntent({ id: 5, status: 'pending' })],
        conflictRunId: 9,
      }),
    );
    expect(state).toEqual({
      kind: 'running',
      runId: 2,
      stage: null,
      index: 0,
      total: 10,
    });
  });

  it('conflict beats a queued intent, an expired intent, and a fresh passed run', () => {
    const state = pickRunControlState(
      baseInput({
        runs: [makeRun({ id: 1, status: 'passed', finishedAt: WITHIN })],
        intents: [
          makeIntent({ id: 5, status: 'pending' }),
          makeIntent({ id: 4, status: 'expired' }),
        ],
        conflictRunId: 9,
      }),
    );
    expect(state).toEqual({ kind: 'conflict', runId: 9 });
  });

  it('a null conflictRunId does not trigger conflict', () => {
    const state = pickRunControlState(baseInput({ conflictRunId: null }));
    expect(state.kind).not.toBe('conflict');
  });

  it('queued beats an expired intent and a fresh passed run', () => {
    const state = pickRunControlState(
      baseInput({
        runs: [makeRun({ id: 1, status: 'passed', finishedAt: WITHIN })],
        intents: [
          makeIntent({ id: 5, status: 'pending' }),
          makeIntent({ id: 4, status: 'expired' }),
        ],
      }),
    );
    expect(state).toEqual({ kind: 'queued', intentId: 5 });
  });

  it('the newest pending intent wins when there are two', () => {
    const state = pickRunControlState(
      baseInput({
        intents: [
          makeIntent({ id: 1, status: 'pending' }),
          makeIntent({ id: 2, status: 'pending' }),
        ],
      }),
    );
    expect(state).toEqual({ kind: 'queued', intentId: 2 });
  });

  it('expired beats a fresh passed run', () => {
    const state = pickRunControlState(
      baseInput({
        runs: [makeRun({ id: 1, status: 'passed', finishedAt: WITHIN })],
        intents: [makeIntent({ id: 4, status: 'expired' })],
      }),
    );
    expect(state).toEqual({ kind: 'expired', intentId: 4 });
  });

  it('a passed run within the window is done, with newCount from the funnel tail', () => {
    const result = {
      stages: [{ name: 'filter', jobsIn: 10, jobsOut: 3, dropsByRule: {} }],
    };
    const state = pickRunControlState(
      baseInput({
        runs: [makeRun({ id: 1, status: 'passed', finishedAt: WITHIN })],
        newestResult: result,
      }),
    );
    expect(state).toEqual({ kind: 'done', runId: 1, newCount: 3 });
  });

  it('a failed run within the window is failed', () => {
    const state = pickRunControlState(
      baseInput({ runs: [makeRun({ id: 1, status: 'failed', finishedAt: WITHIN })] }),
    );
    expect(state).toEqual({ kind: 'failed', runId: 1 });
  });

  it('a crashed run within the window also counts as failed', () => {
    const state = pickRunControlState(
      baseInput({ runs: [makeRun({ id: 1, status: 'crashed', finishedAt: WITHIN })] }),
    );
    expect(state).toEqual({ kind: 'failed', runId: 1 });
  });

  it('a run finished exactly at the DONE_WINDOW_MS boundary still counts', () => {
    const state = pickRunControlState(
      baseInput({
        runs: [makeRun({ id: 1, status: 'passed', finishedAt: AT_BOUNDARY })],
      }),
    );
    expect(state.kind).toBe('done');
  });

  it('a run finished longer ago than DONE_WINDOW_MS falls back to idle', () => {
    const state = pickRunControlState(
      baseInput({ runs: [makeRun({ id: 1, status: 'passed', finishedAt: OUTSIDE })] }),
    );
    expect(state).toEqual({ kind: 'idle' });
  });

  it('a still-running (finishedAt null) newest run outside the running-list check is idle-adjacent, not done', () => {
    const state = pickRunControlState(
      baseInput({ runs: [makeRun({ id: 1, status: 'passed', finishedAt: null })] }),
    );
    expect(state).toEqual({ kind: 'idle' });
  });

  it('no runs, no intents, no conflict is idle', () => {
    expect(pickRunControlState(baseInput())).toEqual({ kind: 'idle' });
  });

  it('a running run with a progress object carries its stage/index/total through', () => {
    const state = pickRunControlState(
      baseInput({
        runs: [makeRun({ id: 7, status: 'running' })],
        progress: { stage: 'filter', index: 7, total: 10 },
      }),
    );
    expect(state).toEqual({
      kind: 'running',
      runId: 7,
      stage: 'filter',
      index: 7,
      total: 10,
    });
  });
});

describe('runControlLabel', () => {
  it('idle -> "Run now"', () => {
    expect(runControlLabel({ kind: 'idle' })).toBe('Run now');
  });

  it('queued -> "Queued (waiting for daemon)"', () => {
    expect(runControlLabel({ kind: 'queued', intentId: 1 })).toBe(
      'Queued (waiting for daemon)',
    );
  });

  it('expired -> "Daemon isn\'t running"', () => {
    expect(runControlLabel({ kind: 'expired', intentId: 1 })).toBe(
      "Daemon isn't running",
    );
  });

  it('running with a stage -> "Running — <stage> <index>/<total>"', () => {
    expect(
      runControlLabel({
        kind: 'running',
        runId: 1,
        stage: 'filter',
        index: 7,
        total: 10,
      }),
    ).toBe('Running — filter 7/10');
  });

  it('running with stage null -> "Running — starting…" (U+2026 ellipsis)', () => {
    const label = runControlLabel({
      kind: 'running',
      runId: 1,
      stage: null,
      index: 0,
      total: 10,
    });
    expect(label).toBe('Running — starting…');
    expect(label).toBe('Running — starting…');
  });

  it('conflict -> "Run in progress — view it"', () => {
    expect(runControlLabel({ kind: 'conflict', runId: 9 })).toBe(
      'Run in progress — view it',
    );
  });

  it('failed -> "Last run failed"', () => {
    expect(runControlLabel({ kind: 'failed', runId: 1 })).toBe('Last run failed');
  });

  it('done -> "Done: <newCount> new"', () => {
    expect(runControlLabel({ kind: 'done', runId: 1, newCount: 3 })).toBe('Done: 3 new');
  });
});
