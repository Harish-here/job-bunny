import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BANNED_SYNONYMS } from './bannedSynonyms.ts';

const [skipPattern, savePattern, glyphPattern] = BANNED_SYNONYMS;

describe('BANNED_SYNONYMS pattern precision (in-memory fixtures)', () => {
  it('Skip pattern matches the decide-action button label shape', () => {
    expect(skipPattern?.pattern.test('>Skip<')).toBe(true);
    expect(skipPattern?.pattern.test('>Skip (x)')).toBe(true);
    expect(skipPattern?.pattern.test('>  Skip<')).toBe(true);
  });

  it('Skip pattern does not match "Skipping" (word boundary)', () => {
    expect(skipPattern?.pattern.test('>Skipping<')).toBe(false);
  });

  it('Skip pattern does not match a different feature\'s "Skip next" label', () => {
    expect(skipPattern?.pattern.test('>Skip next<')).toBe(false);
  });

  it('Skip pattern does not match the bare substring without a leading ">"', () => {
    expect(skipPattern?.pattern.test('const skip = () => {}')).toBe(false);
    expect(skipPattern?.pattern.test('Skip')).toBe(false);
  });

  it('Save pattern matches the decide-action button shape "Save ("', () => {
    expect(savePattern?.pattern.test('>Save (')).toBe(true);
    expect(savePattern?.pattern.test('>Save(')).toBe(true);
  });

  it('Save pattern does not match Settings\' bare "Save changes" verb', () => {
    expect(savePattern?.pattern.test('>Save changes')).toBe(false);
  });

  it('glyph pattern matches each banned unicode glyph', () => {
    for (const glyph of ['✓', '✗', '☆', '↑', '↓', '⚡']) {
      expect(glyphPattern?.pattern.test(glyph)).toBe(true);
    }
  });

  it('glyph pattern does not match ordinary text', () => {
    expect(glyphPattern?.pattern.test('Apply')).toBe(false);
  });
});

// Un-skipped once all fixes landed: DecideBar.tsx's glyph/word violations (blueprint step 17,
// ui-design-system task 6), TriagePage.tsx's ↑/↓ sort-button glyphs (blueprint step 20,
// ui-design-system task 7), SettingsNav.tsx's JSDoc-comment glyph pair (task 7, prose-only
// fix — "up/down" instead of the raw glyphs, zero behaviour change), and the `Skip` pattern's
// precision fix (task 7, orchestrator ruling) that stopped it false-positiving on
// ScheduledRunsCard.tsx's unrelated "Skip next" schedule-skip button.
describe('BANNED_SYNONYMS whole-tree scan', () => {
  it('has zero banned-synonym matches across ui/src', () => {
    // `new URL(...)` alone resolves against jsdom's shimmed global `URL`
    // (jsdom's own `window.location`, not the real module base) in this
    // test environment — explicit `node:url`'s `URL` is the real WHATWG
    // implementation and resolves `import.meta.url`'s `file:` scheme
    // correctly, matching `fileURLToPath`'s own expectation.
    const srcRoot = fileURLToPath(new NodeURL('../../', import.meta.url));
    // This module's own two files (the pattern definitions and this
    // fixture-precision test) necessarily contain the literal banned
    // strings/glyphs as pattern-precision examples — they are the one
    // legitimate, deliberate exception, not a case that needs an
    // allowlist elsewhere. Excluded by exact basename match (`entry.name`,
    // not a relative/full path), not a broad "skip all .test.ts"
    // carve-out, so no other test file — even one with the same basename
    // in a different directory — is shielded from a real violation except
    // by literal coincidence with these two exact filenames.
    const selfExempt = new Set(['bannedSynonyms.ts', 'bannedSynonyms.test.ts']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !selfExempt.has(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(srcRoot);

    for (const { pattern, reason } of BANNED_SYNONYMS) {
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        expect(text, `${file} matched banned pattern: ${reason}`).not.toMatch(pattern);
      }
    }
  });
});
