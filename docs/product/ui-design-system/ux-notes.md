# UX Notes — UI Design System & Triage Job-Details Overhaul

Slug: `ui-design-system` · Author: product-ux · 2026-08-25
Spec (authoritative): `/Users/harishamutha/job-bunny-ui-design-system/docs/product/ui-design-system/spec.md`
Persona: `docs/product/personas.md` v1.4 — P1 "The Operator-Owner", **job-seeker hat**, **JTBD-5**
Mockup: `/Users/harishamutha/job-bunny-ui-design-system/docs/product/ui-design-system/mockup.html`
Prior art not to contradict: `settings-overhaul/ux-notes.md`, `run-experience-overhaul/ux-notes.md`

---

## 0. Design frame

The spec's reshape (§7.3) sets the effort split and I follow it: **colour is documentation, voice is a
rule set, type and glossary are the real holes, and the triage pane is the majority of the value.**
So this dossier is ~20% system reference and ~80% flagship.

Everything sits inside the existing shell — sidebar `w-56`, main `p-6`, `--radius: 1rem`,
`ring-1 ring-foreground/10` cards, lucide at `size-4`, sonner toasts, **state = weight and shape,
never hue alone**. Nothing about the system announces itself (Content Priority #14).

**Two frames I set that the spec left open, and both are mine to set (§10 preamble):**

1. **The pane is a decision instrument, not a document viewer.** Everything above the JD exists to let
   the user answer *no* without reading the JD. The JD is the lean-yes surface and is ranked, sized
   and clamped accordingly.
2. **§10's field ordering is a hypothesis** (spec weakness 4 — transferred from Linear/GitHub/Gmail,
   no in-domain source). I adopt it, with **two deviations I own and name in §9**, and I record the
   falsifier for each so a later pass can kill them on evidence rather than taste.

---

## 1. Design Scale — every value in the mockup comes from this table

Recon'd **verbatim from `ui/src/index.css`** (the single source of truth), not from either prior
mockup. That matters: the two existing mockups disagree on `--muted-foreground` (`#6e5b87` vs
`#6d6280`) and `index.css` settles it at **`#6e5b87`**. `run-experience-overhaul/mockup.html` is the
drifted one. Tint naming (`--primary-tint` vs `--attention-10`) is resolved by **using neither** —
tints render as `color-mix`/alpha of the base token, exactly as `badge.tsx` and `button.tsx` already
do (`bg-destructive/10`), so no new token name is invented.

### 1a. Colour — both modes, with the AA guarantee (R2)

| Token | Utility | Light | Dark | Role |
|---|---|---|---|---|
| `--background` | `bg-background` | `#faf8fd` | `#1a1523` | page |
| `--foreground` | `text-foreground` | `#3d2c55` | `#e6ddf5` | body text |
| `--card` / `--popover` | `bg-card` | `#ffffff` | `#241d30` | cards, panes, popovers |
| `--muted` / `--secondary` | `bg-muted` | `#f1ecf8` | `#2e2540` | inputs, chips, skeletons |
| `--muted-foreground` | `text-muted-foreground` | `#6e5b87` | `#a695c2` | meta, labels, helper |
| `--accent` | `bg-accent` | `#efe8fa` | `#342a47` | selected row |
| `--border` | `border-border` | `#e4dbf0` | `#362c4a` | 1px rules, card ring |
| `--input` | — | `#e4dbf0` | `#3f3355` | input border |
| `--primary` / `--ring` | `bg-primary` | `#7b5ea7` | `#b79ce0` | the one solid action, focus ring |
| `--primary-hover` | — | `#5e4590` | `#c9b4ea` | primary hover |
| `--primary-foreground` | — | `#ffffff` | `#1a1523` | text on primary |
| `--success` | fill only | `#4caf6e` | `#6fcb8e` | match-reason chip fill |
| `--success-strong` | `text-success-strong` | `#26703f` | `#6fcb8e` | match-reason **text** |
| `--destructive` | fill only | `#d64545` | `#f08a8a` | flag rule, error fill |
| `--destructive-strong` | `text-destructive-strong` | `#c62c2c` | `#f08a8a` | flag **text**, error text |
| `--attention` | fill only | `#ff8a3d` | `#ff9e5e` | breaker/degraded fill |
| `--attention-strong` | `text-attention-strong` | `#a04a06` | `#ff9e5e` | attention **text** |
| `--amber` | **fill only — see below** | `#c98a2e` | `#e1a856` | secondary warning graphic |
| `--sidebar` | `bg-sidebar` | `#f3eefb` | `#201a2c` | sidebar |
| `--sidebar-accent` | — | `#e7def7` | `#2e2540` | nav hover/active |
| `--sidebar-border` | — | `#ded2f0` | `#362c4a` | sidebar edge |

**Contrast, computed pair by pair (WCAG 2.1, normal text ≥ 4.5:1). This is R2's guarantee, and it
found a real defect.**

| Pair | Light | Dark | |
|---|---|---|---|
| `foreground` on `card` | **12.4:1** | **12.5:1** | pass |
| `muted-foreground` on `card` | **5.90:1** | 6.6:1 (on `background`) | pass |
| `muted-foreground` on `background` | **5.60:1** | **6.63:1** | pass |
| `primary` on `card` | **5.27:1** | **6.87:1** | pass |
| `success-strong` on `card` | **5.98:1** | **8.31:1** | pass |
| `destructive-strong` on `card` | **5.49:1** | **6.76:1** | pass |
| `attention-strong` on `card` | **6.04:1** | 5.9:1 | pass |
| `success` (plain) on `card` | **2.76:1** | — | **FAIL — fill only** |
| `destructive` (plain) on `card` | **4.35:1** | — | **FAIL — fill only** |
| `attention` (plain) on `card` | **2.34:1** | — | **FAIL — fill only** |
| `amber` (plain) on `card` | **2.92:1** | — | **FAIL — and it has no `-strong` sibling** |

> **Finding for product-ui, and it is a gap in the shipped token set:** every semantic hue has a
> `-strong` text-safe sibling **except `--amber`**. So the rule the reference document must state is:
> **on light, the plain semantic hues are fill/graphic colours only; the `-strong` siblings are the
> text colours; `--amber` is fill-only, permanently, until an `--amber-strong` ships.** In dark, the
> `-strong` tokens are already aliases of their base, so the rule is a no-op there. (Callout **C1**.)

### 1b. Type — the scale this spec creates (R1, R14)

The repo has **no** type tokens; it has an unnamed 5-step de-facto ramp plus two off-scale escapes.
The deliverable is to **name and bound** it, not to re-pitch it.

| Token (new) | Utility | Size / line-height | Weight | Family | Used for |
|---|---|---|---|---|---|
| `--text-micro` | `text-micro` **(NEW)** | **11px / 16px**, `uppercase`, `tracking-[0.04em]` | 500 | sans | zone eyebrows, kbd hints, scope badges, meter labels |
| `--text-xs` | `text-xs` | 12px / 16px | 400 · 500 | sans | meta, badges, chips, helper |
| `--text-sm` | `text-sm` | 14px / 20px | 400 · 500 | sans | **body — 66% of all uses**, rows, inputs, JD |
| `--text-base` | `text-base` | 16px / 24px (`leading-snug` → 22px on headings) | 500 | heading | card titles |
| `--text-lg` | `text-lg` | 18px / 28px | 600 | heading | page + pane titles |
| `--text-2xl` | `text-2xl` | 24px / 32px | 600 | heading | **the one hero number per screen** |

**Deliberate deviation from spec §3's Industry row, and it is a trade, not an oversight.** Research
says Polaris and Atlassian both use a **1.2 ratio**. This ramp is ~1.13–1.33 — Tailwind's shipped
defaults. I adopt the de-facto ramp *verbatim* rather than impose 1.2, because a ratio change
re-flows all 279 existing type sites for **zero user-visible benefit**, and R13 is already flagged as
this spec's largest blast radius (§11 blast-radius table, weakness 7). **The value is in the ramp
being named and bounded, not in its ratio.** Six steps, every one already in use — AC 2's "every step
is used by at least one screen" is satisfied on day one. (Callout **C2**.)

`--text-micro` at **11px, not 10px**, is the one real change: it absorbs all five off-scale escapes
(`text-[10px]` ×4 — `SettingsNav.tsx:106`, `SetupHealthCard.tsx:181`, `DiagnosisPanel.tsx:166`,
`StageRail.tsx:115`; `text-[9px]` ×1 — `FunnelTable.tsx:110`) into one named step, and 9px is not a
legible size for a real label at any weight. **Five sites change by 1–2px; nothing else moves.**

**Tabular numerals (R5):** `font-variant-numeric: tabular-nums` on the match score (both list and
pane), every date, every count, and the funnel/analytics columns.

### 1c. Spacing — Tailwind's 4px grid, unchanged (R28 = Won't)

| Utility | Literal | Used for |
|---|---|---|
| `gap-1` / `p-1` | 4px | icon↔text, kbd padding |
| `gap-1.5` | 6px | button internals, label↔control |
| `gap-2` / `p-2` | 8px | chip rows, badge padding |
| `p-2.5` | 10px | input/button horizontal padding |
| `gap-3` / `p-3` | 12px | card-sm padding, eligibility grid, flag block inset |
| `gap-4` / `p-4` | 16px | **card default padding**, pane zone rhythm |
| `p-5` | 20px | dialog content |
| `gap-6` / `p-6` | 24px | page padding, the two-pane column gap |

### 1d. Radii, borders, motion, elevation

| Token / utility | Literal | Used for |
|---|---|---|
| `--radius` | **16px** (`1rem`) | base; all others derive |
| `--radius-sm` = ×0.6 | 9.6px | small controls, kbd |
| `--radius-md` = ×0.8 | 12.8px | `button size=sm` (clamped `min(...,12px)`) |
| `--radius-lg` = ×1.0 → `rounded-lg` | 16px | button default, input, select |
| `--radius-xl` = ×1.4 → `rounded-xl` | **22.4px** | **cards** (verified `card.tsx`) |
| `--radius-4xl` = ×2.6 → `rounded-4xl` | 41.6px | **badges and chips** (verified `badge.tsx`) |
| card edge | `ring-1 ring-foreground/10`, **no shadow** | the only card edge |
| focus | `ring-3 ring-ring/50` + `border-ring`, `:focus-visible` only | keyboard focus |
| motion | `@utility hop` — **150ms**, `cubic-bezier(0.34,1.56,0.64,1)` | every state transition |
| reduced motion | global guard already shipped — durations → 1ms | honoured |

### 1e. Component idioms (reproduce exactly — verified from source)

| Component | Geometry |
|---|---|
| Button base | `rounded-lg` 16px, `text-sm` 500, `active:translate-y-px`, focus `ring-3 ring-ring/50`, svg `size-4` |
| Button default / sm / xs | `h-8 px-2.5 gap-1.5` · `h-7 px-2.5 gap-1 text-[0.8rem]` r12 · `h-6 px-2 gap-1 text-xs` r10 |
| Variant `default` | `bg-primary` + `text-primary-foreground`, hover `primary/80` — **the only solid fill in the product** |
| Variant `outline` / `ghost` | `border-border bg-background` hover `bg-muted` · transparent hover `bg-muted` |
| Variant `destructive` | **tinted, not solid**: `bg-destructive/10 text-destructive` |
| Card | `bg-card rounded-xl ring-1 ring-foreground/10 text-sm`, `--card-spacing: 16px`; `data-size=sm` → 12px |
| CardTitle | `font-heading text-base leading-snug font-medium` (`text-sm` when `size=sm`) |
| Badge | `h-5 px-2 py-0.5 text-xs font-medium rounded-4xl gap-1`, svg `size-3`; variants `default/secondary/destructive/success/running/outline/ghost` |
| Input / Select trigger | `h-8 px-2.5 text-sm rounded-lg`, `1px solid var(--input)` |
| Skeleton | `bg-muted rounded-md animate-pulse` |

### 1f. Declared exceptions — every value in the mockup outside the table above

| Value | Where | Why |
|---|---|---|
| `system-ui, -apple-system, "Segoe UI", sans-serif` / `ui-rounded, system-ui, sans-serif` | mockup only | Zero external requests. Substitutes Geist/Nunito. Sizes, weights, everything else unchanged. |
| `max-w-[68ch]` | JD body | Butterick 45–90ch. A measure cap is a typographic constraint, not a spacing step. |
| `max-h-[240px]` | JD clamp | = 12 × 20px line-height. Derived from the type scale, not free-form. |
| 48px fade gradient | JD clamp | 2.4 × the 20px line-height; the smallest fade that reads as "more below". |
| `3px` × `12px` meter bars | score band meter | Sub-4px hairline graphic; the grid has no step below 4px and a 4px bar reads as a block. |
| `w-56` (224px) | sidebar | Inherited from the shipped shell, unchanged. |
| `360px` | triage list pane | The pane width from §5; a layout column, not a spacing step. |

**Mockup review chrome — exceptions that exist only in the artefact, never in the app.** Added after
the render's structural check surfaced them; they are listed here rather than silently tolerated,
because the rule below is only honest if it is enforced against the actual file.

| Value | Where | Why it is not an app-surface value |
|---|---|---|
| `10px` type | header strip keys, callout badge numerals | The mockup's own metadata chrome and annotation badges. Neither exists in the product, so neither is bound by the 11px micro floor. |
| `19px` | callout badge diameter | An annotation instrument. Sized to sit inside a 20px badge line without displacing text. |
| `200px` / `220px` | S11 "every screen adopts" sketch tiles | Sketch frames, explicitly not redesigns — they have no shipped counterpart to match. |
| `720px` / `760px` | frame and list-pane max-heights | Scroll-clipping so twelve frames fit one scrolling page. The app panes are viewport-height. |

**Rule for the render: any value not in §1a–1e or §1f is a defect.** Verified mechanically against
the rendered file — 0 external URLs, 34 distinct hex values all drawn from §1a, and every remaining
off-table literal enumerated above.

---

## 2. Voice rules (R6) and the glossary (R7) — the reference frames

**Six voice rules**, the convergent minimum from Polaris / Mailchimp / GOV.UK (spec §3):

1. **Short plain words.** "Use", not "utilise". "Now", not "at this time."
2. **Active voice.** "The filter dropped 189 jobs", not "189 jobs were dropped."
3. **Imperative verb + object on buttons.** One verb per button. Never "Submit", never "OK".
4. **Sentence case everywhere** — buttons, headings, labels, nav. Exception: reserved proper nouns
   (`LinkedIn`, `Greenhouse`, `Keka`, `Notion`) and the frozen status strings, which are byte-exact.
5. **Lead with the main point.** The number first, the caveat second.
6. **One reserved term per concept** — the glossary below is the authority.

**Glossary of reserved words.** Frozen sets are **mirrored, never renamed** (R32; Notion select
strings are byte-exact). Banned synonyms are kept **small and precise** — a noisy gate is a deleted
gate (spec §9).

| Concept | Reserved word(s) | Banned synonyms | Status |
|---|---|---|---|
| Pipeline stages (10) | `reconcile` `farm` `source` `compress` `structure` `assemble` `filter` `dedup` `rank` `sync` | "step", "phase", "task" | **frozen** |
| Run states | New jobs on your board · Ran clean · Ran with warnings · Failed at *stage* · Lost contact · Running — *stage i/n* · Telemetry missing | "success", "error", "OK", "crashed" | mirrored from `runOutcome.ts` |
| Lanes | **LinkedIn · Greenhouse · Keka** | raw `linkedin`/`greenhouse`/`keka`, "source", "scraper", "connector", "provider" | display labels (R10) |
| A pipeline execution | **Run** | "job", "execution", "sync", "crawl" | — |
| A posting on the board | **Job** | "posting", "listing", "role", "opportunity" | — |
| Config scope | **Profile** | "account", "user", "workspace" | — |
| Tracking statuses (8) | Lead · Applied · Recruiter Screen · Tech Round · Onsite · Offer · Rejected · Passed | "Saved" (→ Lead), "Skipped"/"Dismissed" (→ Passed) | **frozen** |
| Excitement (3) | Vera level · Kandipa podu · Try panalam | any English "normalisation" | **frozen, reserved** |
| Triage actions | **Apply · Lead · Pass** | **"Save"** (→ Lead), **"Skip"** (→ Pass), "Dismiss", "Reject" | R11 |
| Form commit | **Save** | "Submit", "Apply", "Confirm" | — |
| The ranking number | **Match score** | "rank", "rating", "fit", "relevance" | R18 |

**The two collisions this closes, stated as the reason the glossary exists:** "Save" meant both
*commit this form* and *mark this job a Lead*; "Skip" and "Passed" were two words for one concept.
After R11, **`Save` is only ever a form verb, and `Apply` on a button is only ever the triage action**
— which is why the settings save bar keeps "Save changes" and never "Apply".

---

## 3. Journey — JTBD-5, entry to completion

**Entry:** Telegram digest or a glance at the sidebar's undecided count → `#/triage`. The user arrives
knowing a batch exists and wanting it gone.

**Steps, per job:** land on the row (arrow/`j`/`k` or click) → **6–7 second scan** of the verdict
header and signals → either *decide immediately* (the majority path) or *expand the JD* (the lean-yes
path) → press `a` / `s` / `x` → next row.

**Completion:** the undecided count hits zero and the list empty state says so. There is no
"finish" button and no summary screen — completion is the absence of work, which is what the persona
actually wants. Tracking fields are filled later, on the tracker, for the jobs that survived.

**Efficiency pass — click and input count, and what I killed.**

| Path | Today | After | Note |
|---|---|---|---|
| Decide one job, mouse | 2 clicks (row, button) | 2 clicks | unchanged; already minimal |
| Decide one job, keyboard | 1 key + a mouse reach for the row | **1 key** (`j`/`k` then `a`/`s`/`x`) | R26 (Could) is what makes the loop zero-mouse; worth promoting |
| Read the full JD | 0 clicks, but it buried the pane | 1 click, **once per session** | expansion is session-sticky (C7) |
| Change a decision | 1 click | 1 click | already reversible in place — no undo mechanism needed (R27) |

**Cut by Occam's razor:** (i) a confirm dialog on any decide action — the action is reversible;
(ii) an undo toast — a mechanism for a problem that doesn't exist; (iii) auto-advance after a
decision — see the honest cost in §11's Error-prevention row, and it would make a mis-press
invisible; (iv) a "job count / progress" widget in the pane — the sidebar badge already carries it;
(v) an in-pane "open original posting" **button** — demoted to a link on the company name, because
the whole point of the rebuild is that the user should not need it (success metric 3).

---

## 4. Screen inventory

| # | Frame | Serves | `data-qa` root |
|---|---|---|---|
| S1 | Triage — **default**, job selected (the flagship) | JTBD-5, R17–R23 | `triage-default` |
| S2 | Triage — **loading** (both panes, skeletons) | Doherty | `triage-loading` |
| S3 | Triage — **empty** (board clear) + detail placeholder | states | `triage-empty` |
| S4 | Triage — **error** (list fetch failed, retry) | states | `triage-error` |
| S5 | Detail — **JD expanded** | R21, concern (b) | `detail-jd-expanded` |
| S6 | Detail — **archived job** | states | `detail-archived` |
| S7 | Detail — **sparse job** (no skills, no reasons, no flags) | empty-within-populated | `detail-sparse` |
| S8 | Detail — **success**: decision recorded, tracking saving/saved/error | states, R11 | `detail-decided` |
| S9 | **Dark twin** of S1 — rendered dark regardless of the global toggle | **G8**, concern (f) | `triage-dark` |
| S10 | **Design system reference** — colour ×2 modes, type ramp, spacing/radius, voice, glossary | R1–R7 | `system-reference` |
| S11 | **"Every screen adopts"** strip — runs · tracker · settings · Operate sketches | R13 | `adopt-strip` |
| S12 | **Non-colour status legend** + greyscale proof | R15, R22, AC 10 | `status-legend` |

---

## 5. S1 — the triage flagship, zone by zone

Two panes inside `p-6`, `gap-6`: **list `w-[360px]`**, **detail `flex-1`, its own scroll, `bg-card
rounded-xl ring-1`**. The detail pane is a Card (R23) — the hand-rolled `rounded-lg border` dies.

### Zone 1 — Verdict header (`p-4`, sticky top of the pane) · `data-qa="verdict-header"`

- **Line 1, left:** `h1` job title, `text-lg font-semibold font-heading`, truncate at two lines.
- **Line 1, right — the score block** (`data-qa="match-score"`), concern **(c)**:
  eyebrow `MATCH` at `text-micro text-muted-foreground`; then **`74`** at `text-2xl font-heading
  tabular-nums` with **`/100`** immediately after at `text-xs text-muted-foreground`; beneath, a
  **4-segment band meter** (4 × 12×3px bars, filled to band) and the band word (`Strong` / `Good` /
  `Fair` / `Weak`) at `text-micro`.
  **The scale is stated inline, every time, in 4 characters** — not in a tooltip, not in a legend.
  The meter is the non-hue second cue for the band (R15): bars fill left-to-right, so the band is
  legible in greyscale. Derived client-side from `score`; **no new data**.
- **Line 2 — provenance,** `text-sm text-muted-foreground`, dot-separated:
  company (link to `url`, `ExternalLink size-3`) · **lane display label** with its icon
  (`Linkedin` / `Building2` / `Building2`) — this is R20/G5, the field the API has always returned and
  nothing has ever shown · `Found 6h ago` (`tabular-nums`, ISO in `title`).
- **Score is `null`:** the block renders `—` with the eyebrow and no meter. Never a bare `0`.

### Zone 2 — Signals: the flagship's central problem · `data-qa="signals"`

Concern **(a)**: make *why it matches* and *review flags* read as different **kinds of thing**,
without hue doing the work. My answer is **three simultaneous non-hue cues plus hue on top**, and the
cues are deliberately **asymmetric in form**:

| | Why it matches | Review flags |
|---|---|---|
| **Container** | free-flowing **chips**, no border | a **left-ruled block**, `border-l-2 border-destructive pl-3` |
| **Icon** | `Check` `size-3` (closed, ticked) | `AlertTriangle` `size-3.5` (open, pointed) |
| **Rhythm** | many · short · **horizontal wrap** · `text-xs` | few · sentence-length · **vertical stack** · `text-sm` |
| Hue (on top only) | `bg-success/10` + `text-success-strong` | `text-destructive-strong` |
| Eyebrow | `WHY IT MATCHES · 4` `text-micro` | `REVIEW FLAGS · 1` `text-micro` |

**Greyscale proof (S12):** strip all hue and the two blocks remain unmistakable — one is a row of
pills with ticks, the other is an indented column with triangles. That is AC 10 satisfied by
construction, not by inspection. (Callout **C3**.)

**Reasons are listed first, flags render heavier.** Deliberate: the reasons are the expected case,
the flag is the exception that changes the decision, and typographic weight — not order — is what
pulls the eye. This is the shipped `run-experience` principle ("state = visual weight, not hue")
applied to the screen that was violating it. (Callout **C4**.)

**Von Restorff, resolved explicitly so the renderer doesn't over-colour:** the pane's *one* visually
distinct element is the **Apply button** — the only solid `bg-primary` fill anywhere on the screen.
The flag block is distinct **within its zone** by shape, never by saturation. Nothing else is filled.

**The two empty cases are NOT symmetric, and this is a design decision rather than an oversight.**

| Case | Treatment | Why |
|---|---|---|
| **No review flags** | **The entire flags block is omitted** — no eyebrow, no `· 0`, no placeholder. | The absence of a caution is the *good* case and the default expectation. Rendering "Review flags · 0" spends a row, and a scan stop, telling the user that nothing is wrong. Occam. |
| **No match reasons** | The eyebrow renders `WHY IT MATCHES` with **no count**, over one muted `text-sm` line: *"No match reasons recorded."* | This absence **is** informative — it says the score is unexplained, which is itself a reason to distrust it. Silently omitting it would hide a fact that changes the decision. |

So a job with neither renders **one muted line and nothing else** in Zone 2 — never two zero-counts.
(Callout **C3**.)

### Zone 3 — Eligibility grid · `data-qa="eligibility"`

Concern **(e)** — a `Card data-size="sm"` holding a `grid grid-cols-2 lg:grid-cols-4 gap-3`. Each
cell: label at `text-micro text-muted-foreground` over value at `text-sm font-medium`.
**LOCATION · WORK TYPE · SENIORITY · TIMEZONE.**

**Why a definition grid and not chips** (research offered both with no winner): chips lose the label,
and at this density the values are *mutually ambiguous* — "Remote", "Senior", "IST", "Bengaluru" read
as four interchangeable tags, which is exactly today's defect (one undifferentiated muted line,
`JobFacts.tsx:11-15`) in a rounder shape. §10 #3 asks for **separable facts**; a labelled grid is the
only one of the three options that guarantees separability. Cost: ~24px more vertical than a single
line — accepted, and named in §11's weakness. (Callout **C5**.)
**Missing value → `—` in `text-muted-foreground`.** Never a blank cell; the grid never reflows.

### Zone 4 — Skills · `data-qa="skills"`

Eyebrow `SKILLS ASKED FOR · 12`, then `Badge variant="secondary"` in a wrap. **Cap 8 visible, then a
`+4 more` ghost toggle** — Miller's chunking; a 25-badge wall is not scannable and it pushed the JD
below the fold. Empty → one muted line, *"No skills extracted."*, **not an empty card**.

### Zone 5 — Job description · `data-qa="jd"`

Concern **(b)**. A `Card`, title *Job description*, header-right `Open original ↗` link.
Body: `max-w-[68ch] text-sm leading-relaxed whitespace-pre-wrap`, **clamped to 12 lines
(`max-h-[240px]`)** with a 48px bottom fade to `--card`, then a `Button variant="ghost" size="sm"`
reading **`Show full description`** / **`Show less`** with `ChevronDown`/`ChevronUp`.

**Why 12 lines:** at 68ch × 20px that is ~800 characters — the opener plus the first requirements
block, which maps to research's 6–7s scan *plus* the ~14.6s requirements read, and it leaves the
tracking card at the fold rather than a screen below it. **This is a hypothesis, and here is its
falsifier:** if the user expands on more than roughly half of jobs, the clamp is too short and should
go to 18 lines; if he never expands, the clamp is doing its job and could tighten to 8. Recording it
this way is the honest response to spec weakness 4. (Callout **C6**.)

**Expansion is session-sticky, not per-job** — expand once and every subsequent job in the batch
renders expanded until collapsed. Tesler's Law: the irreducible complexity ("how much do I read
today?") is answered once by the user and then held by the system, instead of being re-asked eleven
times. (Callout **C7**.) No storage: component state, resets on reload.
Empty `jd` → *"No description captured for this job."* + the `Open original ↗` link, which is the
only case where that link is load-bearing.

### Zone 6 — Tracking · `data-qa="tracking"`

`Card`, title *Tracking*, description *"Fill this in after you decide."* — the copy states its own
rank. `grid grid-cols-2 gap-3`: Status (select, 8 frozen options) · Date applied · Comp range ·
Contact · Next action · Next action date · Notes (full width, ≤5000). **Plus excitement**, as a
3-option segmented control using the reserved strings verbatim.
Commit on blur/change. Per-field feedback at `text-micro`: `Saving…` → `Saved` (fades after 2s);
failure → `aria-invalid` border + `text-destructive-strong text-xs` inline message + the value stays
in the field so nothing is lost.

### Zone 7 — Decide bar · `data-qa="decide-bar"` (sticky bottom, `border-t bg-card px-4 py-2.5`)

| Button | Variant | Icon | Key | Was |
|---|---|---|---|---|
| **Apply** | `default` (solid — the one distinct element) | `Check` | `a` | ✓ Apply |
| **Lead** | `outline` | `Star` | `s` | ☆ **Save** ← the collision |
| **Pass** | `outline` | `CircleSlash` | `x` | ✗ **Skip**, styled `destructive` |

R11 + R23 + R16 in one bar: the words now match the stored vocabulary, the raw unicode glyphs become
lucide, and **Pass loses `variant="destructive"`** — the action is reversible and must not read as
destructive. The current status `Badge` sits at the bar's right and **uses the same word as the button
that caused it** (Pass → `Passed`, Lead → `Lead`, Apply → `Applied`), which is AC 8.
The active decision's button carries `aria-pressed="true"` + `bg-accent` — pressing another one just
changes it. `<kbd>` hints render `text-micro bg-muted rounded-sm px-1`.

**Fitts's Law drove the position.** The bar is sticky at the pane's bottom edge: a fixed, always-hit
target that never moves as the JD expands, sitting exactly where the eye lands after the evidence.
Today's bar sits second-from-top and scrolls away the moment the JD opens — which is the version of
this screen the user actually has. (Callout **C8**.)

### The five states, for the detail pane

| State | Treatment |
|---|---|
| **Default** | as above, job selected |
| **Loading** | zone-shaped skeletons (`bg-muted rounded-md animate-pulse`): title bar, score block, 4 chips, 4 grid cells, 6 JD lines. **Shape-matched, so nothing jumps on load** — Doherty, and the reason there is no spinner |
| **Empty** | no job selected → centred, `text-sm text-muted-foreground`: *"Select a job to decide on it."* + the three shortcut hints. Not an illustration, not a tutorial (persona: not a novice) |
| **Error** | job fetch failed → `AlertTriangle` + *"Couldn't load this job."* + `Button variant="outline"` **Try again**. The list stays usable — one broken job never blanks the screen |
| **Success** | decision recorded → status badge flips **optimistically, <400ms**, decided button goes `aria-pressed`, the list row's pip changes in peripheral vision. No toast (Doherty is satisfied by the optimistic flip; a toast would be noise 11 times a morning). On PATCH failure: badge reverts + inline `text-destructive-strong` line in the bar |

---

## 6. The list pane, and the two remaining concerns

**Row** (`data-qa="job-row"`), 2 lines, `py-2 px-3`, hover `bg-muted`, selected `bg-accent` **+
`border-l-2 border-primary`** (shape + hue, never hue alone):

```
[pip] Senior Platform Engineer                     74 /100
      Acme Corp · Bengaluru · Greenhouse
```
Line 1: `text-sm font-medium truncate` + the score right-aligned, `tabular-nums`, with `/100` at
`text-xs text-muted-foreground`. Line 2: `text-xs text-muted-foreground`, **lane display label
included** (R10/R20 lands on the row too).

**Score band by weight, not hue:** ≥75 `font-semibold text-foreground` · 50–74 `font-medium
text-foreground` · <50 `font-normal text-muted-foreground`. Same rule as the run-experience screens.

**Concern (d) — the second cue for the 6px status dot.** The dot has no room for shape, so **the dot
is replaced, not augmented**: a **12px lucide glyph in a 16px slot**, which is where the shape budget
actually is. Five shapes, Miller-safe:

| State | Glyph | Hue (on top) | `aria-label` |
|---|---|---|---|
| Undecided | `Circle` (hollow ring) | `muted-foreground/40` | "Not decided" |
| Lead | `Star` (filled) | `primary` | "Lead" |
| Applied | `Send` | `primary` | "Applied" |
| In play — Recruiter Screen · Tech Round · Onsite · Offer | `ChevronsRight` | `primary` / `success` on Offer | the status word |
| Closed — Passed · Rejected | `Minus` | `destructive` | the status word |

Legible in greyscale, legible to a screen reader, and it costs zero horizontal space over today's
dot. (Callout **C9**.)

**Left-pane controls** are unchanged (R33): undecided count badge, `/`-focused company search
(250ms debounce), filter popover, Date/Score sort toggles — **whose `↑ ↓` unicode becomes
`ArrowUp`/`ArrowDown` lucide** (R16) — and prev/next pagination with `x–y of z` in `tabular-nums`.

**List states:** *loading* → 6 skeleton rows · *empty* → `CheckCircle2` + *"Nothing left to decide."*
+ *"Your last run added 11 jobs; you've decided on all of them."* + `View the tracker →` (completion
is the absence of work) · *error* → *"Couldn't load your board."* + **Try again** · *success* → rows
update in place; a decided row keeps its position (**never re-sorts under the cursor** — that is the
single fastest way to cause a mis-click on the next job).

---

## 7. Concern (f) — dark mode, the surface nobody has designed

`main.tsx:8-11` follows the OS, so **dark is live and has never been drawn**. This mockup closes G8
two ways, because a toggle alone doesn't survive being printed or screenshotted:

1. A **header toggle** flips a `.dark` class on the mockup root — every frame re-renders in dark, all
   from the `.dark` token block, zero external resources.
2. **S9 is a permanent dark twin of S1**, rendered dark regardless of the toggle, so both modes are
   visible simultaneously and the mockup can be reviewed as a still.

**No in-app toggle ships** (R30 = Won't). The mockup's toggle is a *review instrument*, and the
mockup must say so on its face so nobody implements it. The dark-mode design work itself is:
`-strong` text tokens are aliases of their base in dark (so the light-mode fill/text split is a
no-op), `--card` `#241d30` lifts off `--background` `#1a1523` by luminance alone (no borders needed),
and every pair in §1a is verified ≥4.5:1 in both. **The dark twin is where an unpinned token would
show up as unstyled** — which is exactly the bug class R3 exists to prevent.

---

## 8. S11 — "Every screen adopts" (R13), and its guardrail

Four sketches, each ~200px, **explicitly labelled *type + words only, no layout change***:

- **Runs** — the run-state lexicon rendered as reserved words ("Ran with warnings", "Failed at
  `structure`"), state by weight + icon, durations `tabular-nums`, `text-micro` column eyebrows.
- **Tracker** — the 8 frozen statuses, each with its pip glyph from §6; excitement in the reserved
  Tamil strings; no renaming anywhere.
- **Settings** — the shipped `settings-overhaul` IA untouched; nav group labels move `text-[10px]` →
  `text-micro`; the save bar still reads **Save changes** (never "Apply" — glossary).
- **Operate** — daemon/session/breaker cards; `text-[10px]` badges → `text-micro`; **lane checkbox
  labels become LinkedIn / Greenhouse / Keka** (R10, `WhereJobsComeFromSection.tsx:233`).

**Guardrail, stated on the strip itself:** *"If you can tell a design system shipped on any of these
four screens, R13 over-reached."* (Success metric 6.) These are sketches, not redesigns — that is
what makes R13 a sweep and not a second epic.

---

## 9. My two deviations from §10's ordering, owned and falsifiable

§10 is a hypothesis (spec weakness 4). I deviate twice:

1. **Lane + date found (§10 rank 4) move *up* into the verdict header's line 2, not their own zone.**
   Reason: they are provenance, they fit inline in ~20 characters, and giving them a tier costs a scan
   stop for information that never changes a decision on its own. **Falsifier:** if the user starts
   filtering by lane mentally ("I only trust Greenhouse"), lane earns promotion to a chip beside the
   score.
2. **Excitement (§10 rank 6) moves *down* into the tracking card.** Reason: excitement is a
   **user-authored input**, not machine evidence — every other item in ranks 1–7 is something the
   pipeline computed. Rendering an unset excitement above the JD on an undecided job is showing the
   user an empty box he is about to fill, in the middle of the evidence he is reading. **Falsifier:**
   if excitement is set *before* the decide press rather than after, it belongs back in the scan path.

**One thing I could not design, and it is a write-surface bound, not a choice:** `archived` is not in
`TrackingFields`, and the only job write is the tracking PATCH. So the archived state (S6) renders an
informational `bg-muted` strip — *"Archived — this job is out of the queue."* — with **no Restore
button**, because there is no endpoint to call. Adding one would breach AC 14. Flagged for product-be
as a known dead-end in the user-control primitive.

---

## 10. Accessibility, keyboard, and user control

- **Keyboard path, complete:** `/` focuses search · `j`/`k` (R26, **Could** — and it is what makes the
  loop zero-mouse; I recommend promoting it to Should) or `↑`/`↓` move the selection · `a`/`s`/`x`
  decide · `Tab` reaches every control in DOM order · `Enter`/`Space` on the JD toggle. Shortcut keys
  are **unchanged** by the relabel (R12) — only the hint text changes.
- **Focus** is `ring-3 ring-ring/50` on `:focus-visible` only, never suppressed. The sticky decide bar
  is in DOM order after the tracking card, so `Tab` order matches reading order.
- **Labelled controls:** every status pip has an `aria-label` with the status word; the score block is
  one `aria-label="Match score 74 out of 100, Good"`; the JD toggle carries `aria-expanded`; the
  eyebrows are real `<h3>`s (`text-micro`), not styled divs, so the pane has a heading outline.
- **Contrast:** every pair in §1a computed, both modes, all ≥4.5:1 — with the amber finding (C1).
- **Never colour alone:** score band → meter + weight; signals → container + icon + rhythm; row status
  → glyph shape; selected row → left rule. AC 10 passes in greyscale (S12 proves it).
- **User control:** every decision is reversible in one press with no dialog; the JD collapses; the
  list never re-sorts under the cursor; there are **no dead ends** — every error state carries a
  **Try again**, and a broken single job never blanks the list.

---

## 11. Numbered callouts (mapped to badges in the mockup)

| # | Decision | Rationale / law |
|---|---|---|
| **C1** | Plain semantic hues are **fill-only** on light; `-strong` siblings are the text colours; **`--amber` is fill-only permanently** (no `-strong` sibling exists) | R2's contrast pass computed it: amber 2.92:1, success 2.76:1, destructive 4.35:1 on white. A real gap in the shipped token set, found by designing dark mode's counterpart |
| **C2** | Adopt Tailwind's de-facto ramp verbatim as the named scale; **do not** impose the 1.2 ratio research recommends | Ratio change re-flows 279 sites for zero user benefit; R13 is already the spec's largest blast radius. Value is in *named and bounded*, not in the ratio |
| **C3** | Reasons vs flags separated by **container + icon + rhythm**, hue last | R15 forbids the green/red answer. Three non-hue cues survive greyscale — AC 10 by construction |
| **C4** | Reasons first, flags **heavier** | The exception, not the order, should pull the eye. Applies the shipped "state = weight, not hue" rule to the screen that broke it |
| **C5** | Eligibility as a **labelled grid**, not chips | §10 asks for *separable* facts; chips at this density are mutually ambiguous and reproduce today's defect in a rounder shape |
| **C6** | JD clamped to **12 lines / 68ch**, falsifier recorded | Butterick 45–90ch; 6–7s scan + 14.6s requirements read. **Hypothesis** — spec weakness 4 |
| **C7** | JD expansion is **session-sticky**, not per-job | **Tesler's Law** — the system holds "how much do I read today", instead of re-asking 11 times |
| **C8** | Decide bar **sticky at the pane's bottom** | **Fitts's Law** — a fixed large target that never moves as the JD expands. Today's bar scrolls away the moment the JD opens |
| **C9** | The 6px status dot is **replaced** by a 12px lucide glyph, not augmented | Concern (d): a 6px dot has no shape budget. Five glyphs, Miller-safe, greyscale-legible, zero extra width |
| **C10** | Skills capped at **8 + "+n more"** | **Miller** — a 25-badge wall isn't scannable and it buried the JD |
| **C11** | The **only** solid fill on the screen is the Apply button | **Von Restorff** — one distinct element per screen. Everything else is tint, rule or outline |
| **C12** | No toast, no undo, no confirm on a decision | **Doherty** is met by the optimistic <400ms badge flip. R27: decisions are already reversible in place |
| **C13** | The archived strip has **no Restore action** | The board's only job write is the tracking PATCH and `archived` isn't in it. A control with no endpoint is a dead end (AC 14) |

---

## 12. Pillar scorecard

| Pillar | Score | Rationale |
|---|---|---|
| **Learnability** | **Strong** | The user wrote the data vocabulary; R11 makes the buttons say the words he already stored, so the screen stops contradicting his own model. Shortcut hints are on the buttons. Nothing new to learn except the pip glyphs — see Memorability. |
| **Efficiency** | **Strong** | The decide loop is one keypress; the JD answers "lean-no" in-pane; expansion is asked once per session, not per job; skills and eligibility are scannable in one fixation each. The 6–7s scan is served by the top ~200px alone. |
| **Memorability** | **Medium-Strong** — *non-top* | The design introduces a **new visual grammar** — five pip glyphs, the chip/left-rule signal split, the band meter — and **nothing in the app teaches it** (R31 rules out a gallery, correctly). It's learned by repetition or not at all, and the triage screen carries no legend. S12's legend lives in the mockup, not in the product. For a daily-use screen with one user this is an acceptable bet; it would not be for an occasional screen. |
| **Error prevention** | **Medium** — *non-top, and the named weakness* | See below. |
| **Satisfaction** | **Strong** | Density and directness with no hand-holding, which is what the persona asked for; the pane finally looks like the rest of the product; and dark mode stops being an accident. |

### Named weaknesses — this is not a clean sweep

1. **Error prevention is the weak pillar, and the cause is a decision I stand by.** Three same-size
   adjacent buttons, no confirm, no undo toast (R27 = Won't), and I deliberately **rejected
   auto-advance**. A mis-press of `x` instead of `s` is therefore recoverable **only if the user
   notices** — and the only feedback is a badge flip and a pip change he may already have scrolled
   past. My mitigations are partial: the decided button holds `aria-pressed` + `bg-accent` so the
   state is visible whenever he looks back, the row never re-sorts out from under the cursor, and
   rejecting auto-advance keeps the wrong job on screen instead of replacing it. **It is still the
   most likely way this design costs the user something.** If one thing gets added later, add
   auto-advance *with* a 5s undo — not one without the other.
2. **The eligibility grid is a density regression** (C5). Four labelled cells cost ~24px more than
   today's single muted line, on the screen whose persona note literally says *density beats
   friendliness*. I traded vertical space for separability because §10 ranks separability third and
   the JD clamp gives the space back — but it is a trade, and a reviewer should check it rather than
   inherit it.
3. **The JD clamp is a guess with a number on it** (C6). Twelve lines is derived from research about
   *postings in general*, not from this user reading *these* postings — spec weakness 4, inherited
   honestly. The falsifier is recorded; nothing in this slice will actually run it, because §14
   declines the instrumentation that would.
4. **`--text-micro` at 11px is the smallest thing in the product and I made five sites bigger to get
   there.** 11px at weight 500 uppercase clears legibility, but it is still below the 12px floor most
   published scales stop at. Named because C2's whole argument is "don't move type for no reason" —
   and this moves type.

---

## 13. Render dispatch — the `data-qa` map

Every region that will become a component carries a stable id: `triage-shell` · `job-list` ·
`job-row` · `job-row-pip` · `list-empty` · `list-error` · `list-skeleton` · `detail-pane` ·
`verdict-header` · `match-score` · `score-meter` · `provenance-line` · `lane-label` · `signals` ·
`match-reasons` · `review-flags` · `eligibility` · `skills` · `skills-more` · `jd` · `jd-toggle` ·
`tracking` · `tracking-status` · `tracking-excitement` · `decide-bar` · `decide-apply` ·
`decide-lead` · `decide-pass` · `decide-status-badge` · `archived-strip` · `system-reference` ·
`token-table-light` · `token-table-dark` · `type-ramp` · `voice-rules` · `glossary` · `adopt-strip` ·
`status-legend` · `mode-toggle`.

**Repeat rule.** Ids are unique **except** the two that mark a repeating list element: `job-row` and
`job-row-pip`, which occur once per rendered row. The pip allowance was raised by the renderer rather
than assumed — a row cannot render without its pip, and the alternative was seven untagged pips —
and I am **ratifying it here** so downstream pairing treats both as row-scoped rather than
page-scoped. Every other id resolves to exactly one element.

**Verified in the rendered file:** 48 unique ids — the 39 above plus the 9 frame roots from §4 —
with no missing and no extra.
