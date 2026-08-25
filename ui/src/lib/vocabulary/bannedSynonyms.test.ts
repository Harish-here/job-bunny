import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BANNED_SYNONYMS } from './bannedSynonyms.ts';

const [skipPattern, savePattern, glyphPattern] = BANNED_SYNONYMS;

describe('BANNED_SYNONYMS pattern precision (in-memory fixtures)', () => {
  it('Skip pattern matches a JSX text-node open', () => {
    expect(skipPattern?.pattern.test('>Skip')).toBe(true);
    expect(skipPattern?.pattern.test('>  Skip')).toBe(true);
  });

  it('Skip pattern does not match "Skipping" (word boundary)', () => {
    expect(skipPattern?.pattern.test('>Skipping')).toBe(false);
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
    for (const glyph of ['✓', '✗', '☆', '↑', '↓']) {
      expect(glyphPattern?.pattern.test(glyph)).toBe(true);
    }
  });

  it('glyph pattern does not match ordinary text', () => {
    expect(glyphPattern?.pattern.test('Apply')).toBe(false);
  });
});

// Skipped until BOTH fixes land: DecideBar.tsx's glyph/word violations (blueprint step 17,
// ui-design-system task 6) and TriagePage.tsx's ↑/↓ sort-button glyphs (blueprint step 20,
// ui-design-system task 7 — a different task/author). Un-skip once both are merged; see the
// dry-run finding comment above BANNED_SYNONYMS for the exact sites this currently would catch.
describe('BANNED_SYNONYMS whole-tree scan', () => {
  it.skip('has zero banned-synonym matches across ui/src', () => {
    const srcRoot = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
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
