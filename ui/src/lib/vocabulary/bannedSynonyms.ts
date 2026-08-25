/**
 * Small, precise banned-vocabulary/glyph patterns (R9/R11/R16 — no raw
 * jargon synonyms, no raw unicode glyphs standing in for a lucide icon).
 * Deliberately narrow, not a general "banned word" list:
 *
 * - The `Skip` pattern matches only the decide-action button label shape —
 *   a JSX text-node open followed by `Skip` and then either another tag
 *   (`>Skip<`) or a kbd-hint paren (`>Skip (x)`) — not the bare substring
 *   "Skip" anywhere. This is deliberately narrower than "any `>Skip` JSX
 *   text node": a different feature's button can legitimately read "Skip
 *   next" (Operate page's schedule-skip action, `ScheduledRunsCard.tsx`,
 *   a different concept from the banned triage decide-action label), and
 *   that shape must NOT match. It also never false-positives on code
 *   comments or identifiers (e.g. `nextUndecided`, `skip: 'apply'` object
 *   keys).
 * - The `Save` pattern only matches `Save(` — the exact shape of the
 *   decide-action button label (`☆ Save (s)`) — never bare `"Save
 *   changes"` (Settings' save-bar verb, which must keep working per the
 *   glossary's own stated rule).
 *
 * Dry-run finding (spec §9, run at authoring time against the real
 * `ui/src/**` tree, at task 2 authoring time before any fix had landed):
 * the Skip/Save word patterns fired nowhere then (today's source was
 * `✓ Apply (a)` / `✗ Skip (x)` / `☆ Save (s)`, i.e. a glyph sat between
 * the JSX tag's `>` and the word, so `/>\s*Skip\s*(<|\()/` and
 * `/>\s*Save\s*\(/` didn't align against that text; they exist to catch
 * a regression where the word reappears with no leading icon). The
 * glyph pattern fired at 6 lines then — 1 more than the blueprint's own
 * cited ground truth of 5 (`DecideBar.tsx:20,23,26`,
 * `TriagePage.tsx:126,135`):
 *   - ui/src/features/triage/DecideBar.tsx:20 (`✓`), :23 (`✗`), :26 (`☆`)
 *     — rendered button glyphs; fixed by DecideBar.tsx's rewrite
 *     (blueprint step 17, ui-design-system task 6).
 *   - ui/src/features/triage/TriagePage.tsx:126 (`↑`/`↓`), :135 (`↑`/`↓`)
 *     — rendered sort-button glyphs; fixed by TriagePage.tsx's
 *     unicode→lucide swap (blueprint step 20, ui-design-system task 7).
 *   - ui/src/features/settings/SettingsNav.tsx:75 — `↑`/`↓` inside a JSDoc
 *     comment describing roving-tabindex keyboard behaviour, not a
 *     rendered glyph; reworded to "up/down" prose (ui-design-system
 *     task 7, prose-only, zero behaviour change).
 * All 3 sites above are fixed as of ui-design-system task 7. A 4th,
 * previously-undiscovered false positive surfaced once the whole-tree
 * scan first executed (it had only ever run `it.skip`ped before task 7):
 * `ui/src/features/operate/ScheduledRunsCard.tsx`'s "Skip next" button
 * (skip the next *scheduled run*, an unrelated Operate-page concept) —
 * resolved by narrowing the `Skip` pattern above from `/>\s*Skip\b/` to
 * `/>\s*Skip\s*(<|\()/`, so it matches only the decide-action button's
 * own label shape (task 7, orchestrator ruling), not a broader "Skip ..."
 * phrase in a different feature.
 */
export const BANNED_SYNONYMS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: />\s*Skip\s*(<|\()/,
    reason: '"Skip" as a decide-action label — use "Pass" (R11)',
  },
  {
    pattern: />\s*Save\s*\(/,
    reason: '"Save (…)" as a decide-action label — use "Lead" (R11)',
  },
  { pattern: /[✓✗☆↑↓]/, reason: 'raw unicode glyph — use a lucide icon (R16)' },
];
