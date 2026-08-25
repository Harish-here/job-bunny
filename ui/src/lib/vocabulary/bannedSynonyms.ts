/**
 * Small, precise banned-vocabulary/glyph patterns (R9/R11/R16 — no raw
 * jargon synonyms, no raw unicode glyphs standing in for a lucide icon).
 * Deliberately narrow, not a general "banned word" list:
 *
 * - The `Skip` pattern matches a JSX text-node open (`>Skip`), not the
 *   bare substring "Skip" anywhere — so it never false-positives on code
 *   comments or identifiers (e.g. `nextUndecided`, `skip: 'apply'` object
 *   keys).
 * - The `Save` pattern only matches `Save(` — the exact shape of the
 *   decide-action button label (`☆ Save (s)`) — never bare `"Save
 *   changes"` (Settings' save-bar verb, which must keep working per the
 *   glossary's own stated rule).
 *
 * Dry-run finding (spec §9, run at authoring time against the real
 * `ui/src/**` tree, BEFORE any fix lands): the Skip/Save word patterns
 * fire nowhere (they are dormant by design — today's source is `✓ Apply
 * (a)` / `✗ Skip (x)` / `☆ Save (s)`, i.e. a glyph sits between the JSX
 * tag's `>` and the word, so `/>\s*Skip\b/` and `/>\s*Save\s*\(/` don't
 * align against today's text; they exist to catch a *future* regression
 * where the word reappears with no leading icon). The glyph pattern fires
 * at 6 lines — 1 more than the blueprint's own cited ground truth of 5
 * (`DecideBar.tsx:20,23,26`, `TriagePage.tsx:126,135`), confirmed by a
 * whole-tree scan run at authoring time:
 *   - ui/src/features/triage/DecideBar.tsx:20 (`✓`), :23 (`✗`), :26 (`☆`)
 *     — rendered button glyphs; fixed by DecideBar.tsx's rewrite
 *     (blueprint step 17, ui-design-system task 6).
 *   - ui/src/features/triage/TriagePage.tsx:126 (`↑`/`↓`), :135 (`↑`/`↓`)
 *     — rendered sort-button glyphs; fixed by TriagePage.tsx's
 *     unicode→lucide swap (blueprint step 20, ui-design-system task 7).
 *   - ui/src/features/settings/SettingsNav.tsx:75 — `↑`/`↓` inside a JSDoc
 *     comment describing roving-tabindex keyboard behaviour, not a
 *     rendered glyph. Not named by the blueprint's ground-truth citation
 *     and not owned by any step in this blueprint's task map; left as-is
 *     (out of scope for this task — flagged in the task-2 report for the
 *     orchestrator).
 * None of these 3 fixes land in this task.
 */
export const BANNED_SYNONYMS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: />\s*Skip\b/, reason: '"Skip" — use "Pass" (R11)' },
  {
    pattern: />\s*Save\s*\(/,
    reason: '"Save (…)" as a decide-action label — use "Lead" (R11)',
  },
  { pattern: /[✓✗☆↑↓]/, reason: 'raw unicode glyph — use a lucide icon (R16)' },
];
