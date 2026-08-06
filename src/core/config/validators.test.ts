import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateConfigDoc } from './validators.ts';

const rajniProfileJson = readFileSync(
  fileURLToPath(new URL('../../../profiles/rajni/profile.json', import.meta.url)),
  'utf8',
);

describe('validateConfigDoc', () => {
  it('accepts a valid minimal profile.json', () => {
    assert.doesNotThrow(() =>
      validateConfigDoc('profile.json', JSON.stringify({ connector: 'sqlite' })),
    );
  });

  it('rejects invalid JSON for profile.json', () => {
    assert.throws(() => validateConfigDoc('profile.json', '{not json'), /profile\.json/);
  });

  it('rejects a schema violation for profile.json', () => {
    assert.throws(
      () => validateConfigDoc('profile.json', '{"connector":123}'),
      /profile\.json/,
    );
  });

  it('accepts rajni real profile.json with legacy v0 extra keys', () => {
    assert.doesNotThrow(() => validateConfigDoc('profile.json', rajniProfileJson));
  });

  it('accepts an empty filter.json (every field optional)', () => {
    assert.doesNotThrow(() => validateConfigDoc('filter.json', '{}'));
  });

  it('rejects a filter.json schema violation (blank skill string)', () => {
    assert.throws(
      () => validateConfigDoc('filter.json', '{"skills":{"core":[""]}}'),
      /filter\.json/,
    );
  });

  it('accepts any valid JSON for resume.json (no shape check)', () => {
    assert.doesNotThrow(() => validateConfigDoc('resume.json', '{"anything": true}'));
  });

  it('rejects invalid JSON for resume.json', () => {
    assert.throws(() => validateConfigDoc('resume.json', 'not json'), /resume\.json/);
  });

  it('accepts non-empty search_urls.md', () => {
    assert.doesNotThrow(() =>
      validateConfigDoc('search_urls.md', '# Search URLs\n- https://example.com'),
    );
  });

  it('rejects empty search_urls.md', () => {
    assert.throws(() => validateConfigDoc('search_urls.md', ''), /search_urls\.md/);
  });

  it('rejects whitespace-only search_urls.md', () => {
    assert.throws(
      () => validateConfigDoc('search_urls.md', '   \n  '),
      /search_urls\.md/,
    );
  });
});
