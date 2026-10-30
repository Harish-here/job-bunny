import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JDSchema } from '../../../core/jd/index.ts';
import type { StagePayload } from '../../../pipeline/runner/stage.ts';
import { buildFunnel, RunResultSchema } from './result.ts';

function fakeJD(id: string) {
  return JDSchema.parse({
    identity: {
      id,
      lane: 'fake',
      url: 'https://example.com/jobs/1',
      company: 'Acme',
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  });
}

test('RunResultSchema parses a minimal passed result', () => {
  const result = RunResultSchema.parse({
    profile: 'rajni',
    date: '2026-07-21',
    time: '09-00',
    outcome: 'passed',
    stages: [
      {
        name: 'farm',
        elapsedMs: 100,
        attempts: 1,
        jobsIn: 3,
        jobsOut: 2,
        dropsByRule: { 'title.domain': 1 },
      },
    ],
  });
  assert.equal(result.stages[0]?.dropsByRule['title.domain'], 1);
});

test('RunResultSchema round-trips a result with linkSoftErrors', () => {
  const result = RunResultSchema.parse({
    profile: 'rajni',
    date: '2026-07-21',
    time: '09-00',
    outcome: 'passed',
    stages: [],
    linkSoftErrors: [
      {
        url: 'https://example.com/jobs/search?keywords=frontend',
        label: 'Frontend',
        reason: 'timeout',
      },
      {
        url: 'https://example.com/jobs/search?keywords=backend',
        reason: 'selector drift',
      },
    ],
  });
  assert.equal(result.linkSoftErrors?.length, 2);
  assert.equal(result.linkSoftErrors?.[0]?.label, 'Frontend');
  assert.equal(result.linkSoftErrors?.[1]?.label, undefined);
});

test('RunResultSchema still parses a result without linkSoftErrors (backward compat)', () => {
  const result = RunResultSchema.parse({
    profile: 'rajni',
    date: '2026-07-21',
    time: '09-00',
    outcome: 'passed',
    stages: [],
  });
  assert.equal(result.linkSoftErrors, undefined);
});

test('buildFunnel: jobsIn/jobsOut come from job counts', () => {
  const payloadIn: StagePayload = { jobs: [fakeJD('a'), fakeJD('b')], dropped: [] };
  const payloadOut: StagePayload = { jobs: [fakeJD('a')], dropped: [] };
  const funnel = buildFunnel(payloadIn, payloadOut);
  assert.equal(funnel.jobsIn, 2);
  assert.equal(funnel.jobsOut, 1);
  assert.deepEqual(funnel.dropsByRule, {});
});

test('buildFunnel groups drops by the FIRST failing verdict rule, counting occurrences', () => {
  const payloadIn: StagePayload = { jobs: [], dropped: [] };
  const payloadOut: StagePayload = {
    jobs: [],
    dropped: [
      {
        jd: fakeJD('a'),
        reasons: [
          { rule: 'title.domain', severity: 'hard', pass: false },
          { rule: 'location', severity: 'hard', pass: false },
        ],
      },
      {
        jd: fakeJD('b'),
        // a passing verdict first — the first FAILING verdict should still win
        reasons: [
          { rule: 'skills', severity: 'soft', pass: true },
          { rule: 'title.domain', severity: 'hard', pass: false },
        ],
      },
      {
        jd: fakeJD('c'),
        reasons: [{ rule: 'location', severity: 'hard', pass: false }],
      },
    ],
  };
  const funnel = buildFunnel(payloadIn, payloadOut);
  assert.deepEqual(funnel.dropsByRule, { 'title.domain': 2, location: 1 });
});

test('buildFunnel counts only NEW drops — prior cumulative drops are excluded', () => {
  const priorDrop = {
    jd: fakeJD('old'),
    reasons: [{ rule: 'company.avoid', severity: 'hard' as const, pass: false }],
  };
  const newDrop = {
    jd: fakeJD('new'),
    reasons: [{ rule: 'location', severity: 'hard' as const, pass: false }],
  };
  const payloadIn: StagePayload = { jobs: [fakeJD('x')], dropped: [priorDrop] };
  const payloadOut: StagePayload = { jobs: [], dropped: [priorDrop, newDrop] };
  const funnel = buildFunnel(payloadIn, payloadOut);
  // company.avoid was dropped by a PRIOR stage — it must NOT be recounted here.
  assert.deepEqual(funnel.dropsByRule, { location: 1 });
  assert.equal(funnel.jobsIn, 1);
  assert.equal(funnel.jobsOut, 0);
});
