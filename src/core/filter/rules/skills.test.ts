import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import { skillsRule } from './skills.ts';

function jd(skills: string[]): StructuredJD {
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
      skills,
    },
  };
}

test('intersection size >= minMatch ⇒ passes; detail lists the intersection', () => {
  const cfg: FilterConfig = {
    skills: { core: ['react', 'typescript'], minMatch: 1, severity: 'hard' },
  };
  const verdicts = skillsRule.eval(jd(['React', 'Node']), cfg);
  assert.equal(verdicts?.[0]?.rule, 'skills.core');
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.severity, 'hard');
  assert.ok(verdicts?.[0]?.detail?.includes('react'));
});

test('intersection size below minMatch ⇒ fails', () => {
  const cfg: FilterConfig = {
    skills: { core: ['react', 'typescript'], minMatch: 2, severity: 'hard' },
  };
  const verdicts = skillsRule.eval(jd(['React']), cfg);
  assert.equal(verdicts?.[0]?.pass, false);
});

test('empty JD skills list ⇒ fails against a configured core list', () => {
  const cfg: FilterConfig = {
    skills: { core: ['react'], minMatch: 1, severity: 'hard' },
  };
  const verdicts = skillsRule.eval(jd([]), cfg);
  assert.equal(verdicts?.[0]?.pass, false);
});

test('absent skills config ⇒ undefined', () => {
  const verdicts = skillsRule.eval(jd(['React']), {});
  assert.equal(verdicts, undefined);
});
