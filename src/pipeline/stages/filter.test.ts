import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterConfig } from '../../core/filter/index.ts';
import type { JD, StructuredJD } from '../../core/jd/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { makeFilterStage } from './filter.ts';

function fakeCtx(): StageContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(30_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {
      async readJson() {
        return undefined;
      },
      async writeJson() {},
    },
  };
}

function jd(overrides: {
  id?: string;
  title?: string;
  company?: string;
  workType?: 'onsite' | 'hybrid' | 'remote';
  skills?: string[];
}): StructuredJD {
  return {
    identity: {
      id: overrides.id ?? 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: overrides.company ?? 'Acme Corp',
      title: overrides.title ?? 'Senior Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [{ city: 'Chennai', country: 'IN' }],
      workType: overrides.workType ?? 'remote',
      skills: overrides.skills ?? ['react', 'typescript'],
    },
  };
}

const cfg: FilterConfig = {
  title: {
    domain: { match: ['frontend'], reject: [], severity: 'hard' },
    seniority: { match: ['senior'], reject: ['principal'], severity: 'soft' },
  },
};

test('makeFilterStage: name/timeout/retries', () => {
  const stage = makeFilterStage({});
  assert.equal(stage.name, 'filter');
  assert.equal(stage.retries, 0);
  assert.ok(stage.timeoutMs > 0);
});

test('a hard-fail verdict drops the job into dropped, with the failing verdict as its reason', async () => {
  const stage = makeFilterStage(cfg);
  const input: StagePayload = {
    jobs: [jd({ title: 'Senior Backend Engineer' })],
    dropped: [],
  };

  const out = await stage.run(input, fakeCtx());

  assert.equal(out.jobs.length, 0);
  assert.equal(out.dropped.length, 1);
  assert.ok(out.dropped[0]?.reasons.some((v) => v.rule === 'title.domain' && !v.pass));
});

test('a soft-fail-only job is kept, and the soft verdict is appended to evaluation.verdicts for rank', async () => {
  const stage = makeFilterStage(cfg);
  const input: StagePayload = {
    jobs: [jd({ title: 'Principal Frontend Engineer' })],
    dropped: [],
  };

  const out = await stage.run(input, fakeCtx());

  assert.equal(out.jobs.length, 1);
  assert.equal(out.dropped.length, 0);
  const kept = out.jobs[0] as JD;
  const softFail = kept.evaluation?.verdicts.find((v) => v.rule === 'title.seniority');
  assert.equal(softFail?.pass, false);
  assert.equal(softFail?.severity, 'soft');
});

test('a fully-passing job is kept with its (passing) verdicts recorded and prior dropped records preserved', async () => {
  const stage = makeFilterStage(cfg);
  const priorDrop = { jd: jd({ id: 'li-0' }), reasons: [] };
  const input: StagePayload = { jobs: [jd({})], dropped: [priorDrop] };

  const out = await stage.run(input, fakeCtx());

  assert.equal(out.jobs.length, 1);
  assert.deepEqual(out.dropped, [priorDrop]);
  assert.ok(
    (out.jobs[0] as JD).evaluation?.verdicts.every(
      (v) => v.pass || v.severity === 'soft',
    ),
  );
});

test('empty config never drops (no rules configured)', async () => {
  const stage = makeFilterStage({});
  const input: StagePayload = { jobs: [jd({ title: 'Anything Goes' })], dropped: [] };

  const out = await stage.run(input, fakeCtx());

  assert.equal(out.jobs.length, 1);
  assert.equal(out.dropped.length, 0);
});

test('fails loud when a job has no structured data (filter run before assemble)', async () => {
  const stage = makeFilterStage(cfg);
  const unstructured: JD = { identity: jd({}).identity };
  const input: StagePayload = { jobs: [unstructured], dropped: [] };

  await assert.rejects(() => stage.run(input, fakeCtx()), /structured/);
});
