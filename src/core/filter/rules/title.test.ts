import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import { titleRule } from './title.ts';

function jdWithTitle(title: string): StructuredJD {
  return {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme Corp',
      title,
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
    structured: {
      titleParts: {},
      locations: [],
      skills: [],
    },
  };
}

const domainCfg: FilterConfig = {
  title: { domain: { match: ['frontend'], reject: [], severity: 'hard' } },
};

test('domain pass: normalized title containing a normalized match token passes', () => {
  const verdicts = titleRule.eval(jdWithTitle('Senior Front-End Engineer'), domainCfg);
  assert.ok(verdicts);
  const domain = verdicts?.find((v) => v.rule === 'title.domain');
  assert.equal(domain?.pass, true);
});

test('domain fail: no match token present ⇒ pass false with configured severity and detail', () => {
  const verdicts = titleRule.eval(jdWithTitle('Backend Engineer'), domainCfg);
  const domain = verdicts?.find((v) => v.rule === 'title.domain');
  assert.equal(domain?.pass, false);
  assert.equal(domain?.severity, 'hard');
  assert.ok(domain?.detail?.includes('frontend'));
});

test('seniority reject beats match: reject hit fails even when match also hits', () => {
  const cfg: FilterConfig = {
    title: {
      seniority: { match: ['senior'], reject: ['principal'], severity: 'soft' },
    },
  };
  const verdicts = titleRule.eval(jdWithTitle('Principal Senior Engineer'), cfg);
  const seniority = verdicts?.find((v) => v.rule === 'title.seniority');
  assert.equal(seniority?.pass, false);
  assert.equal(seniority?.severity, 'soft');
  assert.equal(seniority?.detail, 'matched reject list');
});

test('evalCard gives identical verdicts from a bare title string', () => {
  const jdVerdicts = titleRule.eval(jdWithTitle('Senior Front-End Engineer'), domainCfg);
  const cardVerdicts = titleRule.evalCard?.(
    { title: 'Senior Front-End Engineer', company: 'Acme Corp' },
    domainCfg,
  );
  assert.deepEqual(cardVerdicts, jdVerdicts);
});

test('absent title config ⇒ undefined', () => {
  const verdicts = titleRule.eval(jdWithTitle('Senior Front-End Engineer'), {});
  assert.equal(verdicts, undefined);
});
