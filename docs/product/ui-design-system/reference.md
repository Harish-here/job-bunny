# UI Design System — Reference

Slug: `ui-design-system` · Canonical reference document (R4) · No in-app gallery ships (R31) — this
document is the only place the system's tokens, voice rules, and glossary are collected together.

---

## Colour

Every value below is transcribed literally from `ui/src/index.css`'s `:root` (light) and `.dark`
blocks — never re-derived by eye. Source: `ui/src/index.css:65-163`.

### Light

| Token | Utility | Hex | Role |
|---|---|---|---|
| `--background` | `bg-background` | `#faf8fd` | page |
| `--foreground` | `text-foreground` | `#3d2c55` | body text |
| `--card` / `--popover` | `bg-card` | `#ffffff` | cards, panes, popovers |
| `--muted` / `--secondary` | `bg-muted` | `#f1ecf8` | inputs, chips, skeletons |
| `--muted-foreground` | `text-muted-foreground` | `#6e5b87` | meta, labels, helper |
| `--accent` | `bg-accent` | `#efe8fa` | selected row |
| `--border` | `border-border` | `#e4dbf0` | 1px rules, card ring |
| `--input` | — | `#e4dbf0` | input border |
| `--primary` / `--ring` | `bg-primary` | `#7b5ea7` | the one solid action, focus ring |
| `--primary-hover` | — | `#5e4590` | primary hover |
| `--primary-foreground` | — | `#ffffff` | text on primary |
| `--success` | fill only | `#4caf6e` | match-reason chip fill |
| `--success-strong` | `text-success-strong` | `#26703f` | match-reason **text** |
| `--destructive` | fill only | `#d64545` | flag rule, error fill |
| `--destructive-strong` | `text-destructive-strong` | `#c62c2c` | flag **text**, error text |
| `--attention` | fill only | `#ff8a3d` | breaker/degraded fill |
| `--attention-strong` | `text-attention-strong` | `#a04a06` | attention **text** |
| `--amber` | **fill only — no `-strong` sibling exists** | `#c98a2e` | secondary warning graphic |
| `--sidebar` | `bg-sidebar` | `#f3eefb` | sidebar |
| `--sidebar-accent` | — | `#e7def7` | nav hover/active |
| `--sidebar-border` | — | `#ded2f0` | sidebar edge |

### Dark

| Token | Utility | Hex | Role |
|---|---|---|---|
| `--background` | `bg-background` | `#1a1523` | page |
| `--foreground` | `text-foreground` | `#e6ddf5` | body text |
| `--card` / `--popover` | `bg-card` | `#241d30` | cards, panes, popovers |
| `--muted` / `--secondary` | `bg-muted` | `#2e2540` | inputs, chips, skeletons |
| `--muted-foreground` | `text-muted-foreground` | `#a695c2` | meta, labels, helper |
| `--accent` | `bg-accent` | `#342a47` | selected row |
| `--border` | `border-border` | `#362c4a` | 1px rules, card ring |
| `--input` | — | `#3f3355` | input border |
| `--primary` / `--ring` | `bg-primary` | `#b79ce0` | the one solid action, focus ring |
| `--primary-hover` | — | `#c9b4ea` | primary hover |
| `--primary-foreground` | — | `#1a1523` | text on primary |
| `--success` | fill only | `#6fcb8e` | match-reason chip fill |
| `--success-strong` | `text-success-strong` | `#6fcb8e` | match-reason **text** (alias of base in dark) |
| `--destructive` | fill only | `#f08a8a` | flag rule, error fill |
| `--destructive-strong` | `text-destructive-strong` | `#f08a8a` | flag **text**, error text (alias of base in dark) |
| `--attention` | fill only | `#ff9e5e` | breaker/degraded fill |
| `--attention-strong` | `text-attention-strong` | `#ff9e5e` | attention **text** (alias of base in dark) |
| `--amber` | **fill only — no `-strong` sibling exists** | `#e1a856` | secondary warning graphic |
| `--sidebar` | `bg-sidebar` | `#201a2c` | sidebar |
| `--sidebar-accent` | — | `#2e2540` | nav hover/active |
| `--sidebar-border` | — | `#362c4a` | sidebar edge |

**The rule (R2's finding):** every semantic hue has a `-strong` text-safe sibling **except
`--amber`**. On light, the plain semantic hues (`--success`, `--destructive`, `--attention`,
`--amber`) are **fill/graphic colours only**; the `-strong` siblings are the text colours.
**`--amber` is fill-only, permanently, until an `--amber-strong` ships.** In dark, the `-strong`
tokens are already aliases of their base (shown above), so this rule is a no-op there.

---

## Contrast pairs (WCAG 2.1, normal text ≥ 4.5:1)

QA round 1 bug 8 / round 2 bug R2-1: this table is the single source of truth for which pairs are
enforced. `ui/src/lib/tokens.test.ts` parses this table (not a hand-maintained duplicate list), reads
each hex pair straight from `ui/src/index.css`, and for every row marked `pass` asserts both (a) the
computed ratio clears ≥ 4.5:1 in the matching mode(s) and (b) the published number here equals the
computed one to 2 decimals — so a stale or invented number here fails the build, not just a stale
enforcement list. Rows marked FAIL are checked for numeric accuracy only, not the ≥ 4.5:1 threshold.
Source of the numbers themselves: that same helper, both modes.

| Pair | Light | Dark | Verdict |
|---|---|---|---|
| `foreground` on `card` | 12.43:1 | 12.39:1 | pass |
| `muted-foreground` on `card` | 5.98:1 | 5.95:1 | pass |
| `muted-foreground` on `background` | 5.67:1 | 6.55:1 | pass |
| `primary` on `card` | 5.25:1 | 6.84:1 | pass |
| `success-strong` on `card` | 6.05:1 | 8.20:1 | pass |
| `destructive-strong` on `card` | 5.53:1 | 6.73:1 | pass |
| `attention-strong` on `card` | 6.04:1 | 7.97:1 | pass |
| `foreground` on `background` | 11.78:1 | 13.63:1 | pass |
| `primary-foreground` on `primary` | 5.25:1 | 7.52:1 | pass |
| `success` (plain) on `card` | 2.74:1 | — | **FAIL — fill only** |
| `destructive` (plain) on `card` | 4.38:1 | — | **FAIL — fill only** |
| `attention` (plain) on `card` | 2.35:1 | — | **FAIL — fill only** |
| `amber` (plain) on `card` | 2.93:1 | — | **FAIL — and it has no `-strong` sibling** |

---

## Type ramp

6 steps, all already in use — every step is used by at least one screen (AC 2). Source:
`ui/src/index.css`'s `@theme` block (task 1, this blueprint's own addition).

| Token | Size / line-height | Weight | Used for |
|---|---|---|---|
| `--text-micro` | 0.6875rem / 1rem, `uppercase`, `tracking-[0.04em]` | 500 | zone eyebrows, kbd hints, scope badges, meter labels |
| `--text-xs` | 0.75rem / 1rem | 400 · 500 | meta, badges, chips, helper |
| `--text-sm` | 0.875rem / 1.25rem | 400 · 500 | body — 66% of all uses, rows, inputs, JD |
| `--text-base` | 1rem / 1.5rem (`leading-snug` → 1.375rem on headings) | 500 | card titles |
| `--text-lg` | 1.125rem / 1.75rem | 600 | page + pane titles |
| `--text-2xl` | 1.5rem / 2rem | 600 | the one hero number per screen |

All six steps are expressed in `rem`, not `px` — this is the one thing that changed about the ramp
mid-epic (a fix-round finding): an earlier draft of `ui/src/index.css`'s `@theme` block redeclared
the whole scale in hard `px`, which silently breaks the browser's default-font-size scaling for
every string in the app. Only `--text-micro` is a genuine override (0.6875rem, i.e. 11px at the
16px root — not 10px) — it absorbs all five off-scale escapes (`text-[10px]` ×4, `text-[9px]` ×1)
into one named step. The other five steps are **not redeclared in CSS at all**; they pin the
existing de-facto ramp verbatim by relying on Tailwind's own shipped `rem` defaults (~1.13–1.33
ratio — deliberately NOT the 1.2 ratio industry research recommends; see Callout C2 in
`ux-notes.md` §11 for the trade this makes). The table above documents their values for reference;
`ui/src/index.css` itself only declares `--text-micro`.

**Tabular numerals (R5):** `font-variant-numeric: tabular-nums` on the match score (both list and
pane), every date, every count, and the funnel/analytics columns.

---

## Spacing & radii

Tailwind's 4px grid, unchanged (R28 = Won't). Source: `ui/src/index.css:54-60` (radii) and
`ux-notes.md` §1c (spacing).

| Utility | Literal | Used for |
|---|---|---|
| `gap-1` / `p-1` | 4px | icon↔text, kbd padding |
| `gap-1.5` | 6px | button internals, label↔control |
| `gap-2` / `p-2` | 8px | chip rows, badge padding |
| `p-2.5` | 10px | input/button horizontal padding |
| `gap-3` / `p-3` | 12px | card-sm padding, eligibility grid, flag block inset |
| `gap-4` / `p-4` | 16px | card default padding, pane zone rhythm |
| `p-5` | 20px | dialog content |
| `gap-6` / `p-6` | 24px | page padding, the two-pane column gap |

| Token / utility | Literal | Used for |
|---|---|---|
| `--radius` | 16px (`1rem`) | base; all others derive |
| `--radius-sm` = ×0.6 | 9.6px | small controls, kbd |
| `--radius-md` = ×0.8 | 12.8px | `button size=sm` (clamped `min(...,12px)`) |
| `--radius-lg` = ×1.0 → `rounded-lg` | 16px | button default, input, select |
| `--radius-xl` = ×1.4 → `rounded-xl` | 22.4px | cards |
| `--radius-4xl` = ×2.6 → `rounded-4xl` | 41.6px | badges and chips |

Card edge: `ring-1 ring-foreground/10`, no shadow — the only card edge. Focus:
`ring-3 ring-ring/50` + `border-ring`, `:focus-visible` only. Motion: `@utility hop` — 150ms,
`cubic-bezier(0.34,1.56,0.64,1)`, every state transition; honours `prefers-reduced-motion` (durations
→ 1ms).

---

## Voice

Six rules, the convergent minimum from Polaris / Mailchimp / GOV.UK research. Source: `ux-notes.md`
§2.

1. **Short plain words.** "Use", not "utilise". "Now", not "at this time."
2. **Active voice.** "The filter dropped 189 jobs", not "189 jobs were dropped."
3. **Imperative verb + object on buttons.** One verb per button. Never "Submit", never "OK".
4. **Sentence case everywhere** — buttons, headings, labels, nav. Exception: reserved proper nouns
   (`LinkedIn`, `Greenhouse`, `Keka`, `Notion`) and the frozen status strings, which are byte-exact.
5. **Lead with the main point.** The number first, the caveat second.
6. **One reserved term per concept** — the glossary below is the authority.

---

## Glossary

Frozen sets are **mirrored, never renamed** (R32; Notion select strings are byte-exact). Banned
synonyms are kept small and precise — a noisy gate is a deleted gate. Source: `ux-notes.md` §2; the
banned-synonym column is the human-readable mirror of
`ui/src/lib/vocabulary/bannedSynonyms.ts` (task 2) — the two must list the same reserved words.

**Adoption rule (QA round 1 bug 9):** every screen that renders one of the reserved concepts above — a
lane name, a tracking status, or a triage action label — sources it from `ui/src/lib/vocabulary`, never
a hardcoded copy. A screen that renders none of these concepts needs no import from it; a contrived
import with nothing to use it for is not the goal.

| Concept | Reserved word(s) | Banned synonyms | Status |
|---|---|---|---|
| Pipeline stages (10) | `reconcile` `farm` `source` `compress` `structure` `assemble` `filter` `dedup` `rank` `sync` | "step", "phase", "task" | frozen |
| Run states | New jobs on your board · Ran clean · Ran with warnings · Failed at *stage* · Lost contact · Running — *stage i/n* · Telemetry missing | "success", "error", "OK", "crashed" | mirrored from `runOutcome.ts` |
| Lanes | LinkedIn · Greenhouse · Keka | raw `linkedin`/`greenhouse`/`keka`, "source", "scraper", "connector", "provider" | display labels (R10) |
| A pipeline execution | Run | "job", "execution", "sync", "crawl" | — |
| A posting on the board | Job | "posting", "listing", "role", "opportunity" | — |
| Config scope | Profile | "account", "user", "workspace" | — |
| Tracking statuses (8) | Lead · Applied · Recruiter Screen · Tech Round · Onsite · Offer · Rejected · Passed | "Saved" (→ Lead), "Skipped"/"Dismissed" (→ Passed) | frozen |
| Excitement (3) | Vera level · Kandipa podu · Try panalam | any English "normalisation" | frozen, reserved |
| Triage actions | Apply · Lead · Pass | "Save" (→ Lead), "Skip" (→ Pass) — as a decide-action label only; "Skip next" (Operate: skip the next scheduled run) is a distinct reserved phrase and is NOT banned | R11 |
| Form commit | Save | "Submit", "Apply", "Confirm" | — |
| The ranking number | Match score | "rank", "rating", "fit", "relevance" | R18 |

**The two collisions this closes:** "Save" meant both *commit this form* and *mark this job a
Lead*; "Skip" and "Passed" were two words for one concept. After R11, **`Save` is only ever a form
verb, and `Apply` on a button is only ever the triage action** — which is why the settings save bar
keeps "Save changes" and never "Apply".
