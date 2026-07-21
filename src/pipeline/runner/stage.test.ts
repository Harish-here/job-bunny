import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JDSchema } from '../../core/jd/index.ts';
import type { Storage } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from './stage.ts';

function fakeStorage(): Storage {
  const store = new Map<string, unknown>();
  return {
    async readJson(relPath, schema) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath, value) {
      store.set(relPath, value);
    },
  };
}

function fakeCtx(): StageContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(5_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: fakeStorage(),
  };
}

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

test('a fake StageDef<StagePayload, StagePayload> drops one job with a verdict', async () => {
  const stage: StageDef<StagePayload, StagePayload> = {
    name: 'fake-filter',
    timeoutMs: 5_000,
    retries: 0,
    async run(input, ctx) {
      ctx.beat();
      const survivors = input.jobs.filter((jd) => jd.identity.id !== 'drop-me');
      const dropped = [...input.dropped];
      const droppedJd = input.jobs.find((jd) => jd.identity.id === 'drop-me');
      if (droppedJd) {
        dropped.push({
          jd: droppedJd,
          reasons: [{ rule: 'title.domain', severity: 'hard', pass: false }],
        });
      }
      await ctx.storage.writeJson('stage-output.json', { jobs: survivors, dropped });
      return { jobs: survivors, dropped };
    },
  };

  const input: StagePayload = {
    jobs: [fakeJD('keep-me'), fakeJD('drop-me')],
    dropped: [],
  };
  const ctx = fakeCtx();
  const out = await stage.run(input, ctx);

  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0]?.identity.id, 'keep-me');
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]?.jd.identity.id, 'drop-me');
  assert.equal(out.dropped[0]?.reasons[0]?.pass, false);
  assert.equal(stage.name, 'fake-filter');
  assert.equal(stage.retries, 0);
});
