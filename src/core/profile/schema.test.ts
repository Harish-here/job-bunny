import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResumeSchema, SkillClassificationSchema } from './schema.ts';

test('resume parses with defaults', () => {
  const r = ResumeSchema.parse({
    name: 'Rajni Fixture',
    skills: ['react', 'typescript', 'node'],
  });
  assert.deepEqual(r.experience, []);
  assert.equal(r.headline, undefined);
});

test('rejects empty skills and nameless resume', () => {
  assert.throws(() => ResumeSchema.parse({ name: 'X', skills: [] }));
  assert.throws(() => ResumeSchema.parse({ skills: ['react'] }));
});

test('skill classification parses', () => {
  const c = SkillClassificationSchema.parse({
    primary: ['react', 'typescript'],
    secondary: ['graphql'],
  });
  assert.equal(c.primary.length, 2);
});
