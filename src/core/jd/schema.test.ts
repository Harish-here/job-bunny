import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JDSchema, VerdictSchema } from './schema.ts';

const identity = {
  id: 'li-4021337',
  lane: 'linkedin',
  url: 'https://www.linkedin.com/jobs/view/4021337',
  company: 'Acme Corp',
  title: 'Senior Frontend Engineer',
  scrapedAt: '2026-07-21T09:00:00.000Z',
};

test('minimal JD (identity only) parses; optional sections stay absent', () => {
  const jd = JDSchema.parse({ identity });
  assert.equal(jd.identity.company, 'Acme Corp');
  assert.equal(jd.content, undefined);
  assert.equal(jd.structured, undefined);
});

test('full JD parses and evaluation.matchReasons defaults to []', () => {
  const jd = JDSchema.parse({
    identity,
    content: { rawText: 'We are hiring...' },
    structured: {
      titleParts: { domain: 'frontend', seniority: 'senior', func: 'engineer' },
      locations: [{ city: 'Chennai', country: 'IN' }],
      workType: 'hybrid',
      skills: ['react', 'typescript'],
    },
    evaluation: {
      verdicts: [{ rule: 'title.domain', severity: 'hard', pass: true }],
      score: 82,
    },
    sync: { pageId: 'abc123', syncedAt: '2026-07-21T09:05:00.000Z' },
  });
  assert.deepEqual(jd.evaluation?.matchReasons, []);
  assert.equal(jd.structured?.workType, 'hybrid');
});

test('rejects bad url, bad severity, out-of-range score, empty rawText', () => {
  assert.throws(() => JDSchema.parse({ identity: { ...identity, url: 'not-a-url' } }));
  assert.throws(() => VerdictSchema.parse({ rule: 'x', severity: 'fatal', pass: false }));
  assert.throws(() =>
    JDSchema.parse({ identity, evaluation: { verdicts: [], score: 101 } }),
  );
  assert.throws(() => JDSchema.parse({ identity, content: { rawText: '' } }));
});

test('rejects a JD with no identity', () => {
  assert.throws(() => JDSchema.parse({ content: { rawText: 'x' } }));
});
