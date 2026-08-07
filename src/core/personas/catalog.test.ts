import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONA_CATALOG } from './catalog.ts';
import { PersonaCatalogSchema } from './types.ts';

const PINNED_ORDER = [
  'frontend',
  'backend',
  'fullstack',
  'data',
  'devops',
  'product',
  'design',
  'csm',
  'sales',
  'marketing',
  'scratch',
];

test('PERSONA_CATALOG parses against PersonaCatalogSchema', () => {
  assert.doesNotThrow(() => PersonaCatalogSchema.parse(PERSONA_CATALOG));
});

test('the catalog holds exactly 11 personas in the pinned order', () => {
  assert.deepEqual(
    PERSONA_CATALOG.personas.map((p) => p.id),
    PINNED_ORDER,
  );
});

test('persona ids are unique', () => {
  const ids = PERSONA_CATALOG.personas.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('start-from-scratch is last and pre-fills nothing', () => {
  const last = PERSONA_CATALOG.personas[PERSONA_CATALOG.personas.length - 1];
  assert.ok(last);
  assert.equal(last.id, 'scratch');
  assert.deepEqual(last.coreSkills, []);
  assert.deepEqual(last.secondarySkills, []);
  assert.deepEqual(last.title.domain.match, []);
  assert.deepEqual(last.title.domain.reject, []);
  assert.deepEqual(last.title.function.match, []);
  assert.deepEqual(last.title.function.reject, []);
});

test('every title rule term is lowercase and trimmed', () => {
  for (const persona of PERSONA_CATALOG.personas) {
    for (const term of [
      ...persona.title.domain.match,
      ...persona.title.domain.reject,
      ...persona.title.function.match,
      ...persona.title.function.reject,
    ]) {
      assert.equal(term, term.toLowerCase().trim());
    }
  }
});

test('every persona except scratch pre-fills skills and seniority options', () => {
  for (const persona of PERSONA_CATALOG.personas.slice(0, 10)) {
    assert.ok(persona.coreSkills.length > 0, `${persona.id}: coreSkills`);
    assert.ok(persona.secondarySkills.length > 0, `${persona.id}: secondarySkills`);
    assert.ok(persona.seniorityOptions.length > 0, `${persona.id}: seniorityOptions`);
  }
});

test('the catalog version is 1', () => {
  assert.equal(PERSONA_CATALOG.version, 1);
});
