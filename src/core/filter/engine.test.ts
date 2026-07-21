import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD } from '../jd/index.ts';
import type { FilterConfig } from './config.ts';
import { decide, evaluate, evaluateCard } from './engine.ts';

function jd(overrides: {
  title?: string;
  company?: string;
  workType?: 'onsite' | 'hybrid' | 'remote';
  skills?: string[];
}): StructuredJD {
  return {
    identity: {
      id: 'li-1',
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

const fullCfg: FilterConfig = {
  title: {
    domain: { match: ['frontend'], reject: [], severity: 'hard' },
    seniority: { match: ['senior'], reject: ['principal'], severity: 'soft' },
  },
  companies: { avoid: ['Evil Corp'] },
  locations: [{ city: '*', workTypes: ['remote'] }],
  timezones: { accept: ['APAC'], severity: 'hard' },
  skills: { core: ['react'], minMatch: 1, severity: 'hard' },
};

test('full-config JD passing all rules ⇒ decide keep', () => {
  const verdicts = evaluate(jd({}), fullCfg);
  assert.equal(decide(verdicts), 'keep');
});

test('hard title fail ⇒ drop', () => {
  const verdicts = evaluate(jd({ title: 'Senior Backend Engineer' }), fullCfg);
  assert.equal(decide(verdicts), 'drop');
});

test('soft seniority fail alone ⇒ keep (verdict recorded for rank)', () => {
  const verdicts = evaluate(jd({ title: 'Principal Frontend Engineer' }), fullCfg);
  const seniority = verdicts.find((v) => v.rule === 'title.seniority');
  assert.equal(seniority?.pass, false);
  assert.equal(decide(verdicts), 'keep');
});

test('evaluateCard runs only title + company rules', () => {
  const verdicts = evaluateCard(
    { title: 'Senior Frontend Engineer', company: 'Acme Corp' },
    fullCfg,
  );
  const ruleNames = new Set(verdicts.map((v) => v.rule.split('.')[0]));
  assert.deepEqual(ruleNames, new Set(['title', 'company']));
});

test('empty config ⇒ evaluate returns [] and keep', () => {
  const verdicts = evaluate(jd({}), {});
  assert.deepEqual(verdicts, []);
  assert.equal(decide(verdicts), 'keep');
});
