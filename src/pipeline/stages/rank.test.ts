import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD, StructuredJD } from '../../core/jd/index.ts';
import { RankConfigSchema } from '../../core/rank/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { makeRankStage } from './rank.ts';

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

function jd(overrides?: {
  id?: string;
  skills?: string[];
  evaluation?: StructuredJD['evaluation'];
}): StructuredJD {
  return {
    identity: {
      id: overrides?.id ?? 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme Corp',
      title: 'Senior Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      skills: overrides?.skills ?? [],
    },
    ...(overrides?.evaluation ? { evaluation: overrides.evaluation } : {}),
  };
}

test('makeRankStage: name/timeout/retries', () => {
  const stage = makeRankStage(RankConfigSchema.parse({}));
  assert.equal(stage.name, 'rank');
  assert.equal(stage.retries, 0);
  assert.ok(stage.timeoutMs > 0);
});

test('scores every job and attaches score/excitement/matchReasons, preserving dropped', async () => {
  const cfg = RankConfigSchema.parse({});
  const stage = makeRankStage(cfg);
  const priorDrop = { jd: jd({ id: 'li-0' }), reasons: [] };
  const input: StagePayload = { jobs: [jd({})], dropped: [priorDrop] };

  const out = await stage.run(input, fakeCtx());

  assert.equal(out.jobs.length, 1);
  const ranked = out.jobs[0] as JD;
  assert.equal(typeof ranked.evaluation?.score, 'number');
  assert.equal(typeof ranked.evaluation?.excitement, 'string');
  assert.ok(Array.isArray(ranked.evaluation?.matchReasons));
  assert.deepEqual(out.dropped, [priorDrop]);
});

test('a soft-fail verdict left on the job by filter is penalized and surfaced in matchReasons', async () => {
  const cfg = RankConfigSchema.parse({});
  const stage = makeRankStage(cfg);
  const input: StagePayload = {
    jobs: [
      jd({
        evaluation: {
          verdicts: [
            {
              rule: 'title.seniority',
              severity: 'soft',
              pass: false,
              detail: 'seniority mismatch',
            },
          ],
          matchReasons: [],
        },
      }),
    ],
    dropped: [],
  };

  const out = await stage.run(input, fakeCtx());
  const ranked = out.jobs[0] as JD;
  assert.ok(ranked.evaluation?.matchReasons.includes('seniority mismatch'));
});

test('fails loud when a job has no structured data (rank run before filter/dedup)', async () => {
  const cfg = RankConfigSchema.parse({});
  const stage = makeRankStage(cfg);
  const unstructured: JD = { identity: jd({}).identity };
  const input: StagePayload = { jobs: [unstructured], dropped: [] };

  await assert.rejects(() => stage.run(input, fakeCtx()), /structured/);
});
