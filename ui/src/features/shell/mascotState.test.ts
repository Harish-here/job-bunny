import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../../lib/api/types';
import { pickMascotState } from './mascotState';

const NOW = Date.parse('2026-08-07T10:10:00.000Z');
const FRESH_FINISHED = '2026-08-07T10:05:00.000Z'; // 5 minutes before NOW
const STALE_FINISHED = '2026-08-07T09:00:00.000Z'; // 70 minutes before NOW

function makeRun(
  over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'status'>,
): RunSummary {
  return {
    date: '2026-08-07',
    timeDir: '10-00',
    kind: 'run',
    resumedFrom: null,
    startedAt: '2026-08-07T09:55:00.000Z',
    finishedAt: FRESH_FINISHED,
    heartbeatAt: null,
    ...over,
  };
}

function funnel(jobsOut: number): unknown {
  return {
    stages: [
      { name: 'source', jobsIn: 10, jobsOut: 8, dropsByRule: {} },
      { name: 'filter', jobsIn: 8, jobsOut, dropsByRule: {} },
    ],
  };
}

describe('pickMascotState', () => {
  it('is hopping when any run is running', () => {
    const runs = [
      makeRun({ id: 1, status: 'passed' }),
      makeRun({ id: 2, status: 'running' }),
    ];
    expect(
      pickMascotState({ runs, newestResult: undefined, queued: false, now: NOW }),
    ).toBe('hopping');
  });

  it('running beats queued', () => {
    const runs = [makeRun({ id: 1, status: 'running' })];
    expect(
      pickMascotState({ runs, newestResult: undefined, queued: true, now: NOW }),
    ).toBe('hopping');
  });

  it('is ears-up when queued and nothing is running', () => {
    const runs = [makeRun({ id: 1, status: 'passed' })];
    expect(
      pickMascotState({ runs, newestResult: funnel(3), queued: true, now: NOW }),
    ).toBe('ears-up');
  });

  it('queued beats a fresh celebration', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: FRESH_FINISHED })];
    expect(
      pickMascotState({ runs, newestResult: funnel(5), queued: true, now: NOW }),
    ).toBe('ears-up');
  });

  it('is celebrating for a fresh passed run with new matches', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: FRESH_FINISHED })];
    expect(
      pickMascotState({ runs, newestResult: funnel(4), queued: false, now: NOW }),
    ).toBe('celebrating');
  });

  it('is asleep for a passed run older than 10 minutes', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: STALE_FINISHED })];
    expect(
      pickMascotState({ runs, newestResult: funnel(4), queued: false, now: NOW }),
    ).toBe('asleep');
  });

  it('is asleep for a passed run with finishedAt: null', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: null })];
    expect(
      pickMascotState({ runs, newestResult: funnel(4), queued: false, now: NOW }),
    ).toBe('asleep');
  });

  it('is asleep for a passed run with an unparseable finishedAt', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: 'not-a-date' })];
    expect(
      pickMascotState({ runs, newestResult: funnel(4), queued: false, now: NOW }),
    ).toBe('asleep');
  });

  it('is asleep for a passed fresh run whose funnel is null', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: FRESH_FINISHED })];
    expect(
      pickMascotState({
        runs,
        newestResult: { stages: 'not-an-array' },
        queued: false,
        now: NOW,
      }),
    ).toBe('asleep');
  });

  it('is asleep for a passed fresh run whose last stage has jobsOut: 0', () => {
    const runs = [makeRun({ id: 1, status: 'passed', finishedAt: FRESH_FINISHED })];
    expect(
      pickMascotState({ runs, newestResult: funnel(0), queued: false, now: NOW }),
    ).toBe('asleep');
  });

  it('is asleep when runs is empty', () => {
    expect(
      pickMascotState({ runs: [], newestResult: undefined, queued: false, now: NOW }),
    ).toBe('asleep');
  });

  it('picks the newest run by highest id, not array order', () => {
    // Deliberately arranged so neither "pick the first element" nor "pick
    // the last element" would coincidentally produce the correct answer —
    // only "pick the highest id" (id 9, the middle element) does.
    const runs = [
      makeRun({ id: 3, status: 'failed', finishedAt: FRESH_FINISHED }),
      makeRun({ id: 9, status: 'passed', finishedAt: FRESH_FINISHED }),
      makeRun({ id: 5, status: 'passed', finishedAt: STALE_FINISHED }),
    ];
    expect(
      pickMascotState({ runs, newestResult: funnel(4), queued: false, now: NOW }),
    ).toBe('celebrating');
  });
});
