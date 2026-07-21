import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import { companyRule } from './company.ts';

function jdWithCompany(company: string): StructuredJD {
  return {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company,
      title: 'Senior Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      skills: [],
    },
  };
}

const avoidCfg: FilterConfig = { companies: { avoid: ['Evil Corp'] } };

test('avoid hit fails hard regardless of any other config', () => {
  const verdicts = companyRule.eval(jdWithCompany('Evil Corp'), avoidCfg);
  assert.equal(verdicts?.length, 1);
  assert.equal(verdicts?.[0]?.rule, 'company.avoid');
  assert.equal(verdicts?.[0]?.pass, false);
  assert.equal(verdicts?.[0]?.severity, 'hard');
});

test('non-avoid company passes', () => {
  const verdicts = companyRule.eval(jdWithCompany('Good Corp'), avoidCfg);
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.severity, 'hard');
});

test('absent companies config ⇒ undefined', () => {
  const verdicts = companyRule.eval(jdWithCompany('Evil Corp'), {});
  assert.equal(verdicts, undefined);
});

test('"Evil Corp Pvt Ltd" matches avoid entry "Evil Corp" via companyKey', () => {
  const verdicts = companyRule.eval(jdWithCompany('Evil Corp Pvt Ltd'), avoidCfg);
  assert.equal(verdicts?.[0]?.pass, false);
});

test('evalCard matches suffix-insensitively too', () => {
  const verdicts = companyRule.evalCard?.(
    { title: 'Senior Engineer', company: 'Evil Corp Pvt Ltd' },
    avoidCfg,
  );
  assert.equal(verdicts?.[0]?.pass, false);
  assert.equal(verdicts?.[0]?.severity, 'hard');
});
