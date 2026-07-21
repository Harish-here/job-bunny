import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FilterConfigSchema } from './config.ts';

test('spec §6 example config parses with defaults', () => {
  const cfg = FilterConfigSchema.parse({
    title: {
      domain: { match: ['ui', 'frontend', 'front-end', 'full-stack'] },
      function: { match: ['engineer', 'developer', 'architect'] },
      seniority: {
        match: ['senior', 'lead', 'staff'],
        reject: ['intern', 'junior', 'principal'],
        severity: 'soft',
      },
    },
    companies: { avoid: ['Evil Corp'] },
    locations: [
      { city: 'chennai', country: 'IN', workTypes: ['onsite', 'hybrid', 'remote'] },
      { city: '*', workTypes: ['remote'] },
    ],
    timezones: { accept: ['APAC', 'EMEA'] },
    skills: { core: ['react', 'typescript'] },
  });
  assert.equal(cfg.title?.domain?.severity, 'hard');
  assert.deepEqual(cfg.title?.domain?.reject, []);
  assert.equal(cfg.skills?.minMatch, 1);
  assert.equal(cfg.timezones?.severity, 'hard');
});

test('empty config is valid — every rule optional', () => {
  const cfg = FilterConfigSchema.parse({});
  assert.equal(cfg.title, undefined);
});

test('rejects bad workType and minMatch < 1', () => {
  assert.throws(() =>
    FilterConfigSchema.parse({ locations: [{ city: 'x', workTypes: ['office'] }] }),
  );
  assert.throws(() => FilterConfigSchema.parse({ skills: { core: ['a'], minMatch: 0 } }));
});
