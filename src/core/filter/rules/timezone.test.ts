import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD, WorkType } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import { timezoneRule } from './timezone.ts';

function jd(workType?: WorkType, timezone?: string): StructuredJD {
  return {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme Corp',
      title: 'Senior Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      workType,
      timezone,
      skills: [],
    },
  };
}

const cfg: FilterConfig = { timezones: { accept: ['APAC', 'EMEA'], severity: 'soft' } };

test('remote + timezone present + config present + timezone accepted ⇒ passes', () => {
  const verdicts = timezoneRule.eval(jd('remote', 'APAC'), cfg);
  assert.equal(verdicts?.[0]?.rule, 'timezone.accept');
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.severity, 'soft');
});

test('remote + timezone not in accept list ⇒ fails with configured severity', () => {
  const verdicts = timezoneRule.eval(jd('remote', 'PST'), cfg);
  assert.equal(verdicts?.[0]?.pass, false);
  assert.equal(verdicts?.[0]?.severity, 'soft');
});

test('non-remote workType ⇒ rule does not run', () => {
  const verdicts = timezoneRule.eval(jd('hybrid', 'APAC'), cfg);
  assert.equal(verdicts, undefined);
});

test('remote but timezone absent ⇒ rule does not run', () => {
  const verdicts = timezoneRule.eval(jd('remote', undefined), cfg);
  assert.equal(verdicts, undefined);
});

test('remote + timezone present but no timezones config ⇒ rule does not run', () => {
  const verdicts = timezoneRule.eval(jd('remote', 'APAC'), {});
  assert.equal(verdicts, undefined);
});
