import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StructuredJD } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';
import { locationRule } from './location.ts';

function jd(
  locations: { city: string; country?: string }[],
  workType?: 'onsite' | 'hybrid' | 'remote',
): StructuredJD {
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
      locations,
      workType,
      skills: [],
    },
  };
}

const cfg: FilterConfig = {
  locations: [
    { city: 'chennai', country: 'IN', workTypes: ['onsite', 'hybrid', 'remote'] },
    { city: '*', workTypes: ['remote'] },
  ],
};

test('wildcard entry passes any remote location', () => {
  const verdicts = locationRule.eval(jd([{ city: 'Bangalore' }], 'remote'), cfg);
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.severity, 'hard');
});

test('city match (case/token-insensitive) with matching workType passes', () => {
  const verdicts = locationRule.eval(
    jd([{ city: 'Chennai', country: 'IN' }], 'hybrid'),
    cfg,
  );
  assert.equal(verdicts?.[0]?.pass, true);
});

test('no entry allows the combination ⇒ fails hard', () => {
  const verdicts = locationRule.eval(jd([{ city: 'Bangalore' }], 'onsite'), cfg);
  assert.equal(verdicts?.[0]?.pass, false);
  assert.equal(verdicts?.[0]?.severity, 'hard');
});

test('workType absent ⇒ passes with detail "workType unknown" (never drop on missing data)', () => {
  const verdicts = locationRule.eval(jd([{ city: 'Bangalore' }], undefined), cfg);
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.detail, 'workType unknown');
});

test('absent locations config ⇒ undefined', () => {
  const verdicts = locationRule.eval(jd([{ city: 'Chennai' }], 'remote'), {});
  assert.equal(verdicts, undefined);
});

test('empty locations + remote workType ⇒ passes via wildcard config entry (no city evidence, workType alone decides)', () => {
  const verdicts = locationRule.eval(jd([], 'remote'), cfg);
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.severity, 'hard');
});

test('empty locations + remote workType with onsite-only config ⇒ hard-fails (no entry accepts remote at any city)', () => {
  const onsiteOnlyCfg: FilterConfig = {
    locations: [{ city: 'chennai', country: 'IN', workTypes: ['onsite', 'hybrid'] }],
  };
  const verdicts = locationRule.eval(jd([], 'remote'), onsiteOnlyCfg);
  assert.equal(verdicts?.[0]?.pass, false);
  assert.equal(verdicts?.[0]?.severity, 'hard');
  assert.equal(
    verdicts?.[0]?.detail,
    'no config entry accepts this workType (location unknown)',
  );
});

test('empty locations + workType absent ⇒ passes with "workType unknown" (pure missing data)', () => {
  const verdicts = locationRule.eval(jd([], undefined), cfg);
  assert.equal(verdicts?.[0]?.pass, true);
  assert.equal(verdicts?.[0]?.detail, 'workType unknown');
});
