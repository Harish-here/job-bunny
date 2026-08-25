# QA Report — UI Design System & Triage Job-Details Overhaul

**FINAL VERDICT (round 3): GREEN — zero open bugs.**

| Round | HEAD | Result |
|---|---|---|
| 1 | `52792df` | RED — 10 bugs (1 major, 9 minor) |
| 2 | `d8fa393` | RED — all 10 closed; 1 new minor (R2-1, a residual of bug 8's fix) |
| 3 | `aebdaa0` | **GREEN — R2-1 closed; zero open bugs** |

> Round 1 and 2 findings are preserved below for the record. All 11 are verified fixed.
> See §10 (round 2) and §11 (round 3).

---

## 1. Scope Digest

| Item | Value |
|---|---|
| Repo / worktree | `/Users/harishamutha/job-bunny-ui-design-system` |
| Branch | `claude/ui-design-system` |
| HEAD verified | `52792dfc88ad6074f4b561f89935aa6924fc8841` (matches expected) |
| Base | `origin/main` @ `9ba5fce` |
| Artifacts | `spec.md` (15 ACs, 20 Musts) · `ux-notes.md` · `mockup.html` (48 `data-qa` ids, frames S1–S12) · `blueprint.md` (32 steps) · `reference.md` · `personas.md` |
| No `blueprint-be.md` | Correct by design — AC 14 forbids new API surface |
| Diff scope | 67 files, +6129/−187. **Zero changes under `src/` or `test/`.** No new dependency in `ui/package.json`. |
| Accepted deviations honoured | excitement read-only · no `DecideBar` on `#/job/:id` · no theme toggle · auto-advance KEPT · "Skip next" allowed in Operate · sparse fixture's four empty eligibility cells |

**Method:** all four gates run verbatim; the mockup's S1–S12 state inventory mapped to e2e tests; the
built app driven live at 1440×900 against the mockup served at the same viewport; computed styles and
DOM order diffed by script; every interactive element in the triage pane clicked with
before/after accessibility snapshots; a time-boxed hostile pass over the changed surfaces.

---

## 2. Gate Results (verbatim)

All four gates **PASS**. No red gate; verification proceeded in full.

### Gate 1 — `bash -c "export PATH=$PATH:/usr/sbin:/sbin; npm run check"` — **PASS**

```
✔ every src/test/ui .ts and .tsx file fits its cap (impl <= 400, test <= 800) (297.098333ms)
✔ the wired stage factories are exactly the frozen ten-stage order (3.624125ms)
✔ STAGE_BUDGETS mirrors every wired stage's name/timeoutMs/retries exactly, in order (0.41625ms)
✔ SUSPECTED_SUSPEND_GAP_MS exceeds a single daemon tick interval (0.924541ms)
✔ core/schedule/suspend.ts's mirrored TICK_MS matches ops/daemon/daemon.ts's real one (0.184833ms)
ℹ tests 2114
ℹ suites 10
ℹ pass 2114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20364.341917

[exited with code 0]
```

### Gate 2 — `npm run ui:check` — **PASS**

```
Checked 333 files in 655ms. No fixes applied.
Found 28 warnings.
Found 1 info.

 Test Files  131 passed (131)
      Tests  1133 passed (1133)
   Start at  15:38:59
   Duration  42.69s
```

28 biome warnings are pre-existing (`noNonNullAssertion`, `useTemplate`, `noImportantStyles`,
`useOptionalChain`) and non-blocking. The known `SkillsSection.test.tsx` flake did **not** fire; the
gate was run twice and passed 1133/1133 both times.

### Gate 3 — `npm run ui:build` — **PASS**

```
dist/assets/index-DBQ-Ltxn.css                               63.53 kB │ gzip:  11.61 kB
dist/assets/index-ir17qpWE.js                               703.36 kB │ gzip: 202.39 kB
✓ built in 1.49s
(!) Some chunks are larger than 500 kB after minification.
```

2118 modules transformed. The chunk-size warning is pre-existing and non-blocking.

### Gate 4 — `mv .env .env.local-bak && (npm run ui:e2e; rc=$?; mv .env.local-bak .env; exit $rc)` — **PASS**

```
  ✓  74 [default] › e2e/wizard.spec.ts:426:1 › wizard: Back then Next past a step that already wrote
     its own config does not trip the never-clobber guard (767ms)

  74 passed (14.5s)
```

- `shared-docs` project: **53 passed** · `default` project: **74 passed** · **127 total, 0 failed, 0 skipped**
- **`.env` restoration verified**: present at `/Users/harishamutha/job-bunny-ui-design-system/.env`,
  636 bytes, mode `600`, no `.env.local-bak` remaining. Re-confirmed at end of session.

---

## 3. Traceability Matrix

### 3.1 Acceptance Criteria (all 15)

| AC | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Colour: every text pair ≥ 4.5:1 both modes; check **automated**, failing pair = **build failure** | **DELIVERED (round 3)** — `tokens.test.ts` now parses `reference.md`'s table itself (single source), asserting each published number equals the WCAG computation to 2 dp and that every `pass` row clears 4.5:1 in both modes; 34 assertions. **Proven to bite** by mutation (§11.3) | Ratios independently recomputed by me from `index.css` (WCAG relative-luminance): **every text pair passes in both modes** (light 5.25–12.43:1; dark 5.95–13.63:1); `reference.md`'s table is accurate. But **no code computes a contrast ratio** — `tokens.test.ts` only pins hex strings. → **Bug 8** |
| 2 | Type scale as tokens; no `text-[Npx]` anywhere; every step used | **DELIVERED** | `grep -rn 'text-\[' ui/src` → 1 hit, `text-[0.8rem]` in vendored `button.tsx` (rem, not `Npx`, pre-existing). All five `text-[10px]`/`text-[9px]` eliminated. Live measurement across all 7 routes: **only 11/12/14/16/18/24px, zero off-scale** (`sweep-report.md` Part 3) |
| 3 | Voice rules documented; every new/changed button label imperative + sentence case | **DELIVERED** | New labels: Apply · Lead · Pass · Try again · Show full description · Show less · Clear filters · View the tracker → — all imperative, sentence case. `reference.md` §Voice |
| 4 | Exactly one word per concept; banned synonym fails the build | **DELIVERED** (with note) | `bannedSynonyms.test.ts` walks the whole `ui/src` tree and asserts no match against 3 precise patterns. Note: the scan runs under `ui:check`, not `npm run check` — the repo's own architecture puts `ui/` outside the root gate, so the AC's literal wording is unimplementable; CI runs both |
| 5 | `tokens.test.ts` pins every token in the reference doc, both modes; no new dependency | **DELIVERED** | +71 lines pinning `--text-micro`, the 6-step ramp, and 30+ reserved words against `reference.md`; `git diff origin/main...HEAD -- ui/package.json` is **empty** |
| 6 | All eight screens import type tokens **and the vocabulary module**; full e2e green; no layout change outside triage/`#/job/:id` | **DELIVERED (round 2, under orchestrator ruling)** | Type tokens: **all 8** (live-measured). Vocabulary module: **4 of 8** — only triage, job, settings import `lib/vocabulary`; tracker, runs, analytics, Operate, onboarding do not. e2e green (127/127); no non-triage layout change observed across 7 route screenshots. → **Bug 9** |
| 7 | Pane order: score+scale → reasons/flags distinct → eligibility → lane → JD disclosed → tracking last | **DELIVERED** | Script-extracted DOM order matches the mockup **exactly** (`style-diff.md`): `verdict-header → match-score → score-meter → provenance-line → lane-label → signals → match-reasons → eligibility → skills → jd → jd-toggle → tracking → decide-bar`. Reasons = green rounded chips + check icon, wrapped horizontally; flags = 2px red left rule + triangle icon, stacked vertically — distinct by container shape, icon and rhythm, not hue (`stub-detail-pane.png`) |
| 8 | Buttons read "Pass"/"Lead"; badge uses the button's word; `a`/`x`/`s` work; hints match | **DELIVERED** | Live: clicked Pass → badge flipped to `Passed`, `aria-pressed=true`; buttons render `Apply a` / `Lead s` / `Pass x`. Keys pinned by `smoke.spec.ts:73-83` + `:86-97` (both green) |
| 9 | No raw lane identifier in any user-visible string | **DELIVERED** | Live snapshots show `LinkedIn` / `Greenhouse` throughout list and pane. `laneLabel()` maps all three |
| 10 | No state distinguishable by hue alone | **DELIVERED** | `StatusPip` renders 5 distinct lucide shapes + `aria-label` (`Circle`/`Star`/`Send`/`Minus`/`ChevronsRight`); score carries band word + bar meter + weight; flags vs reasons differ by container. Verified in `qa-S1-app.png` |
| 11 | No raw unicode glyph used as an icon in `ui/src/**` | **DELIVERED (round 2)** | Triage glyphs replaced with lucide and gated by `/[✓✗☆↑↓]/`. But `⚡` (U+26A1) still renders as an icon at `tracker/DueStrip.tsx:29`, uncovered by the pattern. → **Bug 10** |
| 12 | `#/job/:id` renders correctly, same field ordering as the triage pane | **DELIVERED** (with note) | Renders clean, zero console errors (`screen-job.png`). Right-column zone order matches triage (`signals → eligibility → skills → tracking`); JD sits in the left column, so absolute DOM order differs — forced by the pre-existing 2-column grid that R33 (Won't) protects, and reasoned explicitly in blueprint §3. Not filed as a bug; see Notes |
| 13 | Detail pane uses shared `Card`; no triage action uses `variant="destructive"` | **DELIVERED** | `DetailPane.tsx` wraps in `<Card>`; `decide-pass` is `variant="outline"`. `grep destructive ui/src/features/triage/DecideBar.tsx` → no hit |
| 14 | Board still `127.0.0.1`-only; no new route, request field or DB column; only job write stays the tracking PATCH | **DELIVERED** | `git diff origin/main...HEAD -- src/ test/` is **empty**. Live: the only PATCH observed was `/api/profiles/rajni/jobs/:id/tracking` |
| 15 | `npm run check` + `npm run ui:check` pass; no file over the 400-line cap | **DELIVERED** | Both green (§2). Cap test green inside gate 1; independent `wc -l` sweep of `ui/src` found zero impl file > 400 and zero test file > 800 |

**AC totals — round 1: 11 delivered · 4 drifted.  Round 2: 14 delivered · 1 drifted.  Round 3 (final): 15 delivered · 0 drifted · 0 missing · 0 untested.**

### 3.2 MoSCoW Musts (all 20)

| Req | Verdict | Evidence |
|---|---|---|
| R1 type scale as tokens | delivered | `--text-micro` added; 5 Tailwind rem steps deliberately not redeclared (documented rationale) |
| R2 colour AA both modes, documented | delivered | Every text pair recomputed and passing (see AC 1); `reference.md` §Contrast pairs |
| R3 `tokens.test.ts` extended | delivered | +71 lines, both modes |
| R4 machine-checked reference doc | delivered | `reference.md` pinned by `tokens.test.ts` (ramp + reserved words) |
| R6 ~6 voice rules recorded | delivered | `reference.md` §Voice |
| R7 glossary of reserved words | delivered | 30+ words pinned incl. all 10 stage names, statuses, excitement levels |
| R8 glossary as code | delivered | `ui/src/lib/vocabulary/` re-exports frozen `STATUS_OPTIONS`/`EXCITEMENT_OPTIONS` from `src/core/tracking/vocab.ts` — mirrored, never renamed |
| R9 Vitest source-scan gate | delivered | whole-tree walk, 3 narrow dry-run-verified patterns |
| R11 Pass/Lead relabel | delivered | live-verified button + badge |
| R12 shortcut hints correct, keys unchanged | delivered | `useTriageKeyboard.ts` untouched; hints `a`/`s`/`x` render; e2e green |
| R13 eight screens adopt tokens + vocabulary | **delivered (round 2, ruling)** | tokens yes (all 8, live-measured); vocabulary module 4 of 8 → **Bug 9** |
| R14 five off-scale values eliminated | delivered | zero `text-[Npx]` remain |
| R15 state never colour-alone | delivered | shape + icon + text cues verified in screenshots |
| R17 pane ordered by decision | delivered | DOM order matches mockup exactly |
| R18 score labelled + scaled | delivered | `MATCH / 95/100 / ▮▮▮▮ STRONG` |
| R19 reasons vs flags visually distinct | **delivered (round 2)** | Correct when rendered (stubbed evidence), but **no fixture produces `reviewFlags`** → **Bug 1** |
| R20 lane surfaced by display name | delivered | `LinkedIn` / `Greenhouse` in pane and rows |
| R21 JD measure-capped + disclosed | delivered | live: clamp + fade + `Show full description` ⇄ `Show less`, session-sticky across job selection |
| R24 `#/job/:id` verified | delivered | renders clean; see AC 12 note |
| R25 existing e2e selectors keep passing | delivered | 127/127 e2e green |

**Must totals — round 1: 18 delivered · 1 drifted · 1 untested.  Round 2: 20 delivered · 0 drifted · 0 untested.**

---

## 4. E2E Coverage Audit — mockup state inventory (48 ids, frames S1–S12)

| Frame | State | Reachable live? | Pinned by | Verdict |
|---|---|---|---|---|
| S1 | Triage default, job selected | yes | `e2e-triage-default`, `e2e-triage-verdict-header`, `e2e-decide-bar-sticky`, `e2e-decide-labels`, `e2e-row-lane-and-pip`, `smoke.spec.ts` ×4 | **covered** |
| S2 | Triage loading, both panes | yes | `e2e-triage-loading` (`list-skeleton`) | **covered** |
| S3 | Triage empty, board clear | yes (route-stub) | unit only (`JobList.test.tsx`) — no e2e | **gap** → Bug 3 |
| S4 | Triage error, list fetch failed | yes (route-stub) | **nothing** — no e2e, no `list-error` id in app | **gap** → Bug 3 |
| S5 | Detail, JD expanded | yes | `e2e-jd-expand` | **covered** |
| S6 | Detail, archived job | **no fixture** | unit only (`ArchivedStrip.test.tsx`) | **gap** → Bug 2 |
| S7 | Detail, sparse job | yes (`rajni-e2e-11`) | `e2e-triage-sparse` | **covered** |
| S8 | Detail, decision recorded | yes | `e2e-triage-decided`, `smoke.spec.ts` `decide persists` | **covered** |
| S9 | Dark twin of S1 | yes (`colorScheme:'dark'`) | **nothing** — no e2e uses `colorScheme` | **gap** → Bug 3 |
| S10 | Design-system reference | n/a | `reference.md` + `tokens.test.ts` | accepted deviation (§8.4) |
| S11 | "Every screen adopts" | n/a | real adoption in each screen's files | accepted deviation (§8.4) |
| S12 | Non-colour status legend | n/a | `StatusPip.test.tsx` covers all 5 states | accepted deviation (§8.4) |

**Per-id status (48):** 32 present in app · 16 absent. Of the 16 absent: 9 are mockup **frame-wrapper**
ids (`triage-default/loading/empty/error/dark`, `detail-jd-expanded/archived/sparse/decided`) that were
never intended as components; 6 are S10–S12 doc ids + `mode-toggle`, all covered by accepted
deviations §8.3/§8.4; 1 is `triage-shell`/`job-list`/`list-error`/`tracking-status`, mapped by
blueprint §2 onto existing unlabelled elements.

**Ids present in the app but rendered in ZERO e2e runs and ZERO live runs** (no fixture can produce them):

| id | Why unreachable | Pinned by |
|---|---|---|
| `review-flags` | no fixture job has `reviewFlags` | unit only → **Bug 1 (major)** |
| `archived-strip` | no fixture job has `archived: true` | unit only → **Bug 2** |
| `tracking-excitement` | no fixture job has `excitement` | unit only → **Bug 2** |
| `skills-more` | no fixture job has > 8 skills (cap) | unit only → **Bug 2** |

All four were proven to render **correctly** under API stubbing (`stub-detail-pane.png`,
`stub-render.mjs`) — this is a coverage gap, not broken behaviour.

---

## 5. Bug List — ROUND 1 (all 10 CLOSED in `d8fa393`, re-verified in §10)

> Zero critical. One major. Nine minor. **No bug has been deferred** — deferral is the user's call
> alone and no user was available.

### Bug 1 — `review-flags` never rendered by any test or fixture — **major** — route-to: `ui`

- **Clause:** R19 (**Must**) "Match reasons and review flags are visually distinct kinds of thing"; AC 7
  "match reasons and review flags as **visually distinct** kinds of thing". Spec §15 names this the
  flagship's *central visual problem*.
- **Repro:** `curl -s http://127.0.0.1:4197/api/profiles/rajni/jobs/rajni-e2e-{1..11}` → `reviewFlags: []`
  for all 11 fixture jobs. `grep -rn "review-flags" ui/e2e` → 0 hits.
- **Evidence:** `style-diff.md` §Absent Elements lists `review-flags` missing from the app render.
  `ui/e2e/fixtures.ts` diff adds exactly one fixture (the sparse job) and no flagged job.
  The zone renders correctly when stubbed (`stub-detail-pane.png`) — so the code is right and the
  *coverage* is absent.
- **Why it matters:** a Must-level visual distinction that no green test exercises. The blueprint added
  a fixture specifically to reach S7; it did not add one to reach the reasons-vs-flags contrast.
- **Fix shape:** add one `FIXTURE_JOBS` entry with non-empty `reviewFlags` and an e2e assertion that
  `review-flags` and `match-reasons` render with different container treatment.

### Bug 2 — `archived-strip`, `tracking-excitement` and `skills-more` render in zero e2e runs — **minor** — route-to: `ui`

- **Clause:** mockup states S6 (`archived-strip`) and S1 (`tracking-excitement`, `skills-more`);
  blueprint §8 divergence 1 makes the read-only excitement Badge the *shipped* substitute for the
  mockup's segmented control — a substitute that has never rendered in the app under test.
- **Repro:** no fixture job has `archived: true`, `excitement`, or more than 3 skills (the "+N more"
  cap is 8). `grep -rn "archived-strip\|tracking-excitement\|skills-more" ui/e2e` → 0 hits.
- **Evidence:** fixture survey (all 11 jobs) in this report §4; all three render correctly when stubbed.
- **Fix shape:** extend the fixture with an archived job, an excitement value, and a >8-skill job.

### Bug 3 — mockup states S3 (empty), S4 (error) and S9 (dark) have no e2e test — **minor** — route-to: `ui`

- **Clause:** mockup frames S3/S4/S9; `ux-notes.md` §10 "every error state carries a Try again — no
  dead ends"; spec §15 usability concern (f) "dark mode… **the mockup for this spec should show it**".
- **Repro:** `grep -rn "list-error\|list-empty\|colorScheme" ui/e2e` → 0 hits for all three.
- **Evidence:** all three verified working by me under route-stubbing (`v2-empty-true.png`,
  `v2-error-list.png`, `v2-error-detail.png`, `dark-triage.png`) — empty shows "Nothing left to
  decide." + "View the tracker →"; both error panes show a working "Try again"; a failed detail fetch
  leaves all 11 rows rendering. Behaviour is correct; nothing pins it.
- **Fix shape:** three e2e specs using `route.fulfill` (empty/500) and a `colorScheme:'dark'` project.

### Bug 4 — `EligibilityGrid` omits the "Eligibility" zone eyebrow — **minor** — route-to: `ui`

- **Clause:** `mockup.html` S1 line 355 and S7 line 702 both render
  `<div class="text-micro muted">Eligibility</div>` inside the eligibility card. No `blueprint.md` §8
  divergence records its removal.
- **Repro:** open `#/triage`, select any job — the card jumps straight to `LOCATION / WORK TYPE /
  SENIORITY / TIMEZONE`. It is the only zone in the pane without its label.
- **Evidence:** `qa-S1-app.png` vs `qa-S1-mockup.png`; `EligibilityGrid.tsx` renders only the grid.

### Bug 5 — `DecideBar` omits `justify-content: space-between`; status badge is not right-aligned — **minor** — route-to: `ui`

- **Clause:** `mockup.html:180` — `.decide-bar{…display:flex;justify-content:space-between;…}`; the
  mockup's markup makes the three buttons one child and `decide-status-badge` its sibling, pushing the
  badge to the far right. No §8 divergence filed.
- **Repro:** the app groups the badge immediately after the Pass button.
- **Evidence:** `qa-S1-app.png` vs `qa-S1-mockup.png`; `style-diff.md` row `decide-bar | gap | 12px | 8px`;
  `DecideBar.tsx` root is `flex items-center gap-2` with no justification.

### Bug 6 — `SkillsList` empty branch omits the "Skills asked for · 0" eyebrow — **minor** — route-to: `ui`

- **Clause:** `mockup.html` S7 line 711 — `<h3 class="text-micro zone-eyebrow">Skills asked for · 0</h3>`
  above "No skills extracted." No §8 divergence filed.
- **Repro:** `#/triage` → select "Backend Engineer (Contract)" (`rajni-e2e-11`) — only the muted line renders.
- **Evidence:** live accessibility snapshot of the sparse pane shows a bare `paragraph: No skills extracted.`
  with no preceding heading. Inconsistent with `JobSignals.tsx`, which *keeps* its eyebrow in the same
  frame and cites S7 as "authoritative for this branch's DOM shape".

### Bug 7 — `ArchivedStrip` renders **after** the verdict header instead of before it — **minor** — route-to: `executor`

- **Clause:** `blueprint.md` §3 specifies the pane renders, top to bottom,
  "`ArchivedStrip` (conditional) → `JobHeader` (verdict-header…)". `mockup.html` S6 line 637 places
  `archived-strip` immediately before `verdict-header`.
- **Repro:** stub any job with `archived: true` — the strip appears below the title, score and provenance line.
- **Evidence:** `stub-detail-pane.png`; `JobHeader.tsx` renders `<ArchivedStrip>` as its own last child,
  so it can never precede the header. Drift against **both** the mockup and an explicit blueprint step.

### Bug 8 — AC 1's automated contrast check does not exist — **minor** — route-to: `ui`

- **Clause:** AC 1 — "the check is **automated** and listed pair by pair. **A pair that fails is a build
  failure, not a note.**"
- **Repro:** `grep -rn "contrast\|luminance\|4\.5\|WCAG" ui/src` → the only hit is a heading in
  `reference.md`. No code computes a ratio.
- **Evidence:** I recomputed every pair myself (WCAG relative luminance, both modes) — **all text pairs
  pass**, and `reference.md`'s numbers are accurate to rounding. So the *substance* of R2 holds; the
  *enforcement mechanism* AC 1 names shipped as a note instead. The hex pins in `tokens.test.ts` are a
  partial proxy: they fail on any colour change, but never on a contrast violation as such.
- **Fix shape:** ~30 lines in `tokens.test.ts` — parse the `:root`/`.dark` hex, compute ratios, assert ≥ 4.5.

### Bug 9 — five of eight screens do not import the vocabulary module — **minor** — route-to: `ui`

- **Clause:** R13 (**Must**) "All **eight** screens … consume the type-scale tokens **and the vocabulary
  module**"; AC 6 "All eight screens import the type tokens and the vocabulary module."
- **Repro:** `grep -rn "lib/vocabulary" ui/src --include='*.tsx' --include='*.ts' | grep -v test` → real
  imports only in `triage/JobRow.tsx`, `triage/DecideBar.tsx`, `job/JobHeader.tsx`,
  `settings/sections/WhereJobsComeFromSection.tsx`. `tracker/grouping.ts` and `triage/decide.ts` merely
  *mention* it in comments. Tracker, runs, analytics, Operate and onboarding import nothing from it.
- **Evidence:** the adoption pass changed `tracker/grouping.ts` by comment only; `TERMINAL_STATUSES`
  remains a hardcoded value-level mirror.
- **Note for the router:** type-token adoption **is** complete on all eight (live-measured, §3.1 AC 2), and
  biome would flag a contrived unused import — so the likely correct resolution is a recorded §8
  divergence narrowing R13's vocabulary half to screens that render lane or triage-action words, not a
  code change. Filed as a bug because no such divergence exists today.

### Bug 10 — raw unicode glyph used as an icon at `tracker/DueStrip.tsx:29` — **minor** — route-to: `ui`

- **Clause:** AC 11 — "No raw unicode glyph is used as an icon in `ui/src/**`; icons are lucide."
- **Repro:** `#/tracker` renders a due badge reading `⚡ Cognivue — prep sys design (Yesterday)`.
- **Evidence:** `screen-tracker.png`; source line
  `⚡ {row.company} — {row.tracking?.nextAction} (` — U+26A1 HIGH VOLTAGE SIGN standing in for a `Zap`
  icon. The banned-glyph pattern `/[✓✗☆↑↓]/` does not cover it, so the gate that AC 11 relies on cannot
  enforce AC 11's stated scope.
- **Note for the router:** R16's own requirement text scopes the replacement to *triage* and is a
  **Should**; AC 11 states the broader `ui/src/**` claim. Either the glyph goes or AC 11's scope gets a
  recorded divergence.

---

## 6. Deferred

**None.** No bug has been deferred. Deferral is the user's decision alone, relayed through the
orchestrator; this run was unattended and no such approval exists or may be assumed.

---

## 7. Residual Risk

Green would have meant "no known bugs", never "no bugs". Red means the same in reverse — this list is
what was found, not what exists. What was **not** or **could not** be tested:

1. **The spec's own riskiest assumption is still unverified.** Spec §15 names R13 the riskiest
   requirement — a mechanical sweep across 281 files whose regression "must be verified screen by
   screen against the shipped UI." I verified seven routes by screenshot and font-size extraction with
   zero console errors and a strictly bounded type ramp. I did **not** pixel-compare each non-triage
   screen against its pre-change appearance, so a subtle same-token, different-weight shift on a screen
   I only eyeballed remains possible.
2. **Three of the pane's zones have never rendered outside a stub.** Bugs 1–2. Their unit tests pass and
   my API stubbing proved the components correct, but no end-to-end path exercises them, so their
   *integration* (props threaded from a real API payload through `DetailPane`) is unproven for real data
   shapes I did not invent.
3. **Auto-advance retargets a fast second click onto a different job.** Empirically demonstrated: clicking
   Apply then Pass with no gap sent `{"status":"Applied"}` to `rajni-e2e-8` and `{"status":"Passed"}` to
   `rajni-e2e-9` — the auto-advanced neighbour. No data loss, well-formed writes, reversible in place, and
   this is precisely the cost `ux-notes.md` §11 predicted and the orchestrator knowingly accepted
   (ruling (a), §8 divergence 7). **Not filed as a bug** — it is an accepted deviation behaving as ruled —
   but it is now measured rather than theoretical, and it is the sharpest edge of that ruling.
4. **Single fixture profile, single viewport, single browser.** Everything was driven as `rajni` at
   1440×900 in chromium. Responsive behaviour is explicitly out of scope (blueprint §3, desktop-only
   local tool), but no other width, profile or engine was exercised.
5. **Real-data shapes are unrepresented.** The fixture's 11 jobs all carry tidy 3-skill, 2-reason,
   0-flag payloads. Long titles, missing companies, unicode-heavy JDs and very large skill lists were
   not exercised beyond the sparse fixture and one 2000-character search input.
6. **The counter-metric the spec itself flags cannot be checked here.** Spec §13 metric 7: "if the
   banned-synonym list is ever emptied or the scan skipped, the glossary pillar has failed — check the
   list's contents, not the test's green tick." I checked the contents: 3 patterns, narrow and
   dry-run-justified. Whether that list survives its own author's next inconvenience is a process risk
   no test can hold.
7. **Nothing here proves the feature serves the user.** A clean matrix is not evidence that the rebuilt
   triage pane shortens the decide loop. Spec §14 declined the instrumentation that would measure it and
   §15 weakness 5 concedes the point; metric 3 remains observed, not measured, at n=1.

---

## 8. Verdict

**Round 1: RED — 10 open bugs. Superseded by §10's round-2 verdict.**

All four gates are green and the flagship is genuinely well built: the detail pane's DOM order matches
the mockup exactly, every computed font-size, weight, line-height, padding and radius matched on the
paired regions, the type ramp is bounded to six steps across all seven screens, every colour pair clears
AA in both modes, and the app is free of console errors on every route. The open bugs are one Must-level
**coverage** gap (`review-flags`, the spec's own named central visual problem, exercised by no test and
reachable by no fixture) plus nine minors — four small mockup-fidelity omissions, two enforcement
mechanisms that shipped as prose instead of code, and three unpinned mockup states.

Green requires zero open bugs. Routing and any deferral decision belong to the orchestrator and the
user respectively.

---

## 9. Evidence Index

| Artefact | Path |
|---|---|
| Gate logs | `<scratch>/gate-check.log`, `gate-ui-check.log`, `gate-ui-build.log`, `gate-e2e.log` |
| Computed-style + DOM-order diff | `<scratch>/style-diff.md`, `style-diff.mjs` |
| Adoption sweep (7 routes, type scale, sticky reachability) | `<scratch>/sweep-report.md` |
| App S1 vs mockup S1 | `<scratch>`… `qa-S1-app.png`, `qa-S1-mockup.png` |
| Standalone job page | `qa-jobpage.png`, `<scratch>/screen-job.png` |
| Stubbed flags/excitement/archived | `<scratch>/stub-detail-pane.png`, `stub-render.mjs` |
| Dark mode | `<scratch>/dark-triage.png` |
| Empty / error states (verified rerun) | `<scratch>/v2-empty-true.png`, `v2-error-list.png`, `v2-error-detail.png` |
| Per-screen adoption | `<scratch>/screen-{triage,tracker,runs,analytics,operate,settings,job}.png` |
| Contrast recomputation | `<scratch>/contrast.py` |

`<scratch>` = `/private/tmp/claude-501/-Users-harishamutha-Job-bunny/465ca30d-622f-40bd-8819-90e5c501b789/scratchpad`

**Environment restored:** board server (4197) and mockup server (4198) stopped; `profiles/rajni`'s
fixture DB re-seeded to canonical state via `ui/e2e/seed.ts` (11 jobs; tracking on `rajni-e2e-2/3/4`
only); `.env` intact at 636 bytes mode 600 with no `.env.local-bak` remaining; `git status --porcelain`
clean. No application code was read-modified — this report is the only file written.

---

# 10. ROUND 2 — Scoped Re-verification (`d8fa393`)

**Scope:** the 10 round-1 bugs, plus the full gate suite (never gates alone), plus an exploratory walk
**varied** from round 1 and aimed at the fixes themselves.

| Item | Value |
|---|---|
| HEAD verified | `d8fa3932902f85b13d3bc9f08e76128810883891` (matches expected) |
| Delta from round 1 | 22 files, +903/−67 (incl. this report's round-1 text) |
| Fixture | 12 jobs (was 11) — `rajni-e2e-12` archived; `rajni-e2e-6` gains 2 review flags, `excitement: 'Vera level'`, 10 skills |
| Environment restored | board server stopped · fixture DB re-seeded (12 jobs, `rajni-e2e-12` archived, tracking on `-2/-3/-4` only) · `.env` intact 636 B mode 600 · `git status --porcelain` clean |

## 10.1 Gate Results — round 2 (all four PASS)

| Gate | Result | Counts |
|---|---|---|
| `npm run check` | **PASS** | `tests 2114 · pass 2114 · fail 0` (typecheck + lint + boundaries 494 modules + test) |
| `npm run ui:check` | **PASS** | `Test Files 131 passed · Tests 1153 passed` (**+20** vs round 1's 1133 — the new WCAG assertions) · 28 pre-existing biome warnings |
| `npm run ui:build` | **PASS** | 2118 modules, `dist/assets/index-Cc9WpSiQ.js` |
| `npm run ui:e2e` | **PASS** | `shared-docs 53 passed` + `default 82 passed` = **135 passed, 0 failed, 0 skipped** (**+8** vs round 1's 127) |

`.env` restoration re-verified: present, 636 bytes, mode `600`, no `.env.local-bak`. The known
`SkillsSection.test.tsx` flake did not fire.

**All 8 new e2e ids confirmed to have actually run** (not merely a green total):

```
✓  71 [default] › e2e/triage-redesign.spec.ts:276:1 › e2e-signals-flags (440ms)
✓  73 [default] › e2e/triage-redesign.spec.ts:307:1 › e2e-archived-strip (702ms)
✓  75 [default] › e2e/triage-redesign.spec.ts:337:1 › e2e-skills-more (397ms)
✓  77 [default] › e2e/triage-redesign.spec.ts:363:1 › e2e-tracking-excitement (365ms)
✓  79 [default] › e2e/triage-redesign.spec.ts:378:1 › e2e-list-empty (1.1s)
✓  80 [default] › e2e/triage-redesign.spec.ts:394:1 › e2e-list-empty-true (200ms)
✓  81 [default] › e2e/triage-redesign.spec.ts:419:1 › e2e-list-error (1.6s)
✓  82 [default] › e2e/triage-redesign.spec.ts:454:1 › e2e-dark-mode (195ms)
```

## 10.2 Round-1 bug re-verification — 10 of 10 CLOSED

| # | Sev | Fix | Re-verification evidence | Verdict |
|---|---|---|---|---|
| 1 | major | `rajni-e2e-6` gains 2 soft-fail verdicts → `reviewFlags`; `e2e-signals-flags` | **Live**: pane shows `WHY IT MATCHES · 2` (green chips, `flex-wrap`, Check icons) above `REVIEW FLAGS · 2` (2px red left rule, `flex-col`, AlertTriangle icons). The e2e asserts both zones' classes *and* per-entry icon counts — not mere existence. `r2-S1-flags.png` | **CLOSED** |
| 2 | minor | 12th archived fixture + excitement + 10 skills; 3 new e2e | **Live**: `skills-more` 8→10 badges with `+2 more` ⇄ `Show less`; `tracking-excitement` renders `Excitement / Vera level` with **0 interactive controls** (pins the read-only deviation) and is **absent** on a job without excitement; `archived-strip` reachable via the real "Show archived" filter | **CLOSED** |
| 3 | minor | `e2e-list-empty`, `-true`, `e2e-list-error`, `e2e-dark-mode`; `ErrorRetry` gained an optional `qa` prop | All four pass. `e2e-list-error` un-routes and clicks retry, asserting **recovery**, not just the error. `e2e-dark-mode` asserts `html.dark` **and** the computed pane background byte-matches dark `--card` | **CLOSED** |
| 4 | minor | `Eligibility` eyebrow added | **Measured**: `[data-qa="eligibility"]` innerText = `"ELIGIBILITY\nLOCATION\nBengaluru\n…"`. Treatment matches the mockup (whose `.text-micro` itself carries `text-transform:uppercase; letter-spacing:.04em; font-weight:500`) | **CLOSED** |
| 5 | minor | `justify-between` on the decide-bar root | **Measured**: `justifyContent: space-between`; bar `x 592 w 840`, badge `x 1329.8 w 86.2` → **16.0 px** from the bar's right edge, 410.8 px of gap after Pass. Badge is right-aligned as the mockup specifies | **CLOSED** |
| 6 | minor | `SKILLS ASKED FOR · 0` eyebrow on the empty branch | **Measured**: sparse job innerText = `"SKILLS ASKED FOR · 0\n\nNo skills extracted."` | **CLOSED** |
| 7 | minor | `ArchivedStrip` hoisted to a fragment sibling before `verdict-header` | **Measured live**: pane order = `archived-strip > verdict-header > match-score > …`; `strip.y 40 < header.y 88`. Also pinned by `e2e-archived-strip`'s own DOM-index assertion | **CLOSED** |
| 8 | minor | Dependency-free WCAG 2.1 helper + `it.each` over 8 pairs × 2 modes in `tokens.test.ts`; `reference.md` numbers corrected | 16 assertions + 2 sanity tests (21:1 white-on-black, 1:1 identical) now run in `ui:check`. Corrected table matches my independent recomputation exactly on all 8 enforced rows | **CLOSED** — but see **R2-1** |
| 9 | minor | Orchestrator ruling + `runs` adopts `laneLabel()` | `runDiagnosis.ts` and `DiagnosisPanel.tsx` now import `laneLabel`; 6 real import sites across triage, job, settings, runs. Live: `#/runs` leaks no raw lane id | **CLOSED under ruling** |
| 10 | minor | lucide `Zap` + `⚡` added to the banned glyph class | **Live**: `#/tracker` contains no raw `⚡`; the due badge renders `Cognivue — prep sys design (Yesterday)` with 1 lucide `<svg>`. Gate now enforces `/[✓✗☆↑↓⚡]/` tree-wide | **CLOSED** |

**Orchestrator ruling recorded (bug 9, AC 6 / R13).** Vocabulary adoption applies only to screens that
render a reserved concept. Under that ruling: triage, job, settings and runs render one and all four
import the module; tracker, analytics, Operate, onboarding and shell render none and need no import.
AC 6 and R13 are recorded **delivered** on that basis. This is a scope ruling relayed through the
orchestrator, not a user approval, and it is recorded here rather than silently absorbed.

## 10.3 Exploratory pass — varied from round 1

Round 1 probed bad routes, rapid row/decide clicks and oversized inputs. Round 2 deliberately walked
different ground, concentrated on the changed surfaces (defect clustering):

| Probe | Result |
|---|---|
| Decide (`Lead`) on an **archived** job | Write succeeds, badge → `Lead`, `archived-strip` persists. No crash |
| `skills-more` state across a job switch | Expands 8→10; **stays expanded** when switching away and back (React reuses the `SkillsList` instance). Consistent with the JD's deliberate session-sticky disclosure; expanded is a superset view, so not user-hostile. Not a defect — see Notes |
| Excitement badge on a job **without** excitement | Correctly absent (count 0), no empty shell |
| Filter to zero **while a job is selected**, then clear | `list-empty` shows the filtered copy; the detail pane correctly unmounts (count 0); `Clear filters` restores all 11 rows |
| 4× rapid "Show archived" toggling | No crash, no duplicate rows, list settles correctly |
| Dark × review-flags × skills-more together | `html.dark`; pane bg `rgb(36,29,48)` = dark `--card`; flag text `rgb(240,138,138)` = dark `--destructive-strong` (6.73:1); reason text `rgb(111,203,142)` = dark `--success-strong` (8.20:1); the 2px left rule survives dark, so the **shape** cue is not light-mode-only |
| Console / page errors across the whole walk | **none** |

## 10.4 Bug List — ROUND 2

### Bug R2-1 — the new contrast gate omits the most-rendered muted-text pair; `reference.md` overstates its own coverage — **minor** — route-to: `ui`

- **Clause:** AC 1 — "**Every** foreground/background token pair **used for text** … the check is
  automated and listed pair by pair." Also R4 — `reference.md` is "machine-checked … so it cannot drift."
- **Repro:**
  - `CONTRAST_PAIRS` in `ui/src/lib/tokens.test.ts` enforces **8** pairs. `muted-foreground` on
    `background` is **not** among them.
  - `reference.md`'s contrast table lists **9** rows marked `pass`, including
    `muted-foreground on background`, under prose that claims the helper "asserts ≥ 4.5:1 in both modes
    for **every row below marked `pass`**". That claim is false for that row.
  - That row's published numbers are also wrong in **both** modes: table says `5.60:1 / 6.63:1`;
    recomputed from `index.css` they are **5.67:1 / 6.55:1**.
- **Evidence that the pair is real, not a technicality:** an in-page scan of `#/triage` found
  **20 text elements** currently rendering `--muted-foreground` (`rgb(110,91,135)`) on `--background`
  (`rgb(250,248,253)`) — the entire job list's score column and every company·location·lane meta line.
  It is the most-rendered muted pairing on the flagship screen, and it is the one pair the new
  automated check skips.
- **Not an accessibility failure:** both computed ratios clear AA comfortably. This is an
  enforcement-coverage and document-accuracy defect, not a contrast defect.
- **Fix shape:** add `['muted-foreground', 'background', …]` to `CONTRAST_PAIRS` and correct the two
  numbers in `reference.md` — or drop the row from the table if the pair is judged out of scope. One line
  plus two numbers either way.

## 10.5 Deferred

**None.** Deferral is the user's decision alone, relayed through the orchestrator. This run was
unattended; no such approval exists or may be assumed on the user's behalf.

## 10.6 Residual Risk — round 2

Carrying forward round-1 items 1, 4, 5 and 7 (all still open), plus:

1. **The contrast gate's pair list is hand-maintained, and this round proves it can miss.** The helper is
   correct; its input list is a hand-written array with no cross-check against `reference.md`'s table.
   R2-1 is one instance; nothing prevents the next added token from being listed-but-unenforced the same
   way. The document and the array should be derived from one source, not maintained in parallel.
2. **`runs`' `laneLabel()` call sites did not render live.** Bug 9's fix touches the `expired-login` and
   `throttle-breaker` diagnosis strings, which require a *failed run* to display; the fixture has zero
   runs. Verified by source read and unit coverage, not by a live render.
3. **The archived state has exactly one fixture and one path to reach it.** `rajni-e2e-12` is reachable
   only through the FilterPopover's "Show archived" toggle, which is exclusive (archived-only, not
   archived-plus-active). Archived behaviour in a *mixed* list is untested and unreachable by design.
4. **Round 1's auto-advance finding is unchanged and unmitigated.** A fast second decide click still
   retargets onto the auto-advanced neighbour. Accepted deviation, behaving as ruled — but the fixture
   grew this round, so the neighbour a mis-click lands on has changed.
5. **Everything green here is still only "no known defects."** Two rounds of testing have found 11
   defects; that is evidence the surface yields defects under scrutiny, not evidence the next round
   would find none.

## 10.7 Round 2 Verdict

**RED — 1 open bug (minor: R2-1). No PR opened.**

All 10 round-1 bugs are verified fixed, most of them well beyond the letter of the finding — the new
e2e tests assert behaviour and layout rather than mere existence, and the fixture was extended without
disturbing a single existing count assertion. All four gates are green with 20 more unit tests and 8
more e2e tests than round 1, and the exploratory walk over the changed surfaces produced zero console
errors and no new defects. The single open item is a residual of bug 8's own fix: the automated
contrast check the fix introduced omits the one pair that renders on 20 elements of the flagship
screen, while the canonical reference document claims that pair is enforced and publishes two wrong
numbers for it.

Green requires zero open bugs. Routing belongs to the orchestrator; deferral belongs to the user.

---

# 11. ROUND 3 — Final Scoped Verification (`aebdaa0`)

**Scope:** bug R2-1, plus the full gate suite (never gates alone). The commit touches
`ui/src/lib/tokens.test.ts` and `docs/product/ui-design-system/reference.md` **only** — verified via
`git show --name-only`, zero application code — so the regression surface is the gate suite itself.

## 11.1 Gate Results — round 3 (all four PASS)

| Gate | Result | Counts |
|---|---|---|
| `npm run check` | **PASS** | `tests 2114 · pass 2113 · fail 0 · skipped 1` (see §11.4) |
| `npm run ui:check` | **PASS** | `Test Files 131 passed · Tests 1169 passed` (**+16** vs round 2's 1153) · 28 pre-existing biome warnings |
| `npm run ui:build` | **PASS** | 2118 modules · `dist/assets/index-Cc9WpSiQ.js` · built in 384ms |
| `npm run ui:e2e` | **PASS** | `shared-docs 53` + `default 82` = **135 passed, 0 failed, 0 skipped** |

`.env` restoration verified: present, 636 bytes, mode `600`, no `.env.local-bak` remaining.

## 11.2 R2-1 fix — verified three independent ways

**(a) Every documented number independently recomputed.** I re-parsed `reference.md`'s table and
recomputed all **13** rows from `ui/src/index.css` with my own WCAG relative-luminance implementation,
without reference to the repo's helper: **13 rows parsed, 0 mismatches.** The previously-wrong values
are all corrected — `muted-foreground on background` now reads `5.67 / 6.55` (was `5.60 / 6.63`), and
the four fill-only rows now read `2.74 / 4.38 / 2.35 / 2.93` (were `2.76 / 4.35 / 2.34 / 2.92`). Every
one of the 9 `pass` rows clears 4.5:1 in both modes.

**(b) The tests demonstrably executed** — not merely a green total. `vitest --reporter=verbose` on
`tokens.test.ts` (156 tests passed) lists **34 contrast assertions**: 2 sanity (21:1 white-on-black,
1:1 identical), 1 non-empty-parse guard, 9 `REQUIRED_PASS_PAIRS` row-existence guards, 13 light-ratio
tests (all rows incl. the four FAIL rows) and 9 dark-ratio tests. Three of them name the pair R2-1 was
about:

```
✓ reference.md documents muted-foreground on background as a pass row
✓ 'muted-foreground on background': light ratio matches reference.md and clears threshold if pass
✓ 'muted-foreground on background': dark ratio matches reference.md and clears threshold if pass
```

**(c) The design cannot pass vacuously.** `parseContrastTable` **throws** if the table header is
absent; a `found at least one contrast row` test guards a zero-row parse; and the names-only
`REQUIRED_PASS_PAIRS` list catches any of the 9 pass rows being deleted from the doc. Both directions
are asserted — the published number must *equal* the computed one (`.toBe`, 2 dp), and `pass` rows must
additionally clear 4.5:1. FAIL rows are still numerically pinned, so the fill-only figures cannot drift
either.

## 11.3 Mutation proof — the gate actually bites

AC 1 requires that "a pair that fails is a **build failure**, not a note." Reading the test is not
evidence of that; making it fail is. Two mutations were applied to `reference.md` (inside this report's
own write boundary), each run against `tokens.test.ts` and then reverted:

**Mutation A — publish a wrong number** (`5.67:1` → `5.99:1`):

```
× 'muted-foreground on background': light ratio matches reference.md and clears threshold if pass
AssertionError: muted-foreground on background (light) computed 5.67:1 vs published 5.99:1:
  expected 5.67 to be 5.99 // Object.is equality
Tests  1 failed | 155 passed (156)
```

**Mutation B — delete the row from the table entirely:**

```
× reference.md documents muted-foreground on background as a pass row
AssertionError: missing pass row: `muted-foreground` on `background`: expected undefined to be defined
Tests  1 failed | 153 passed (154)
```

`reference.md` was restored via `git checkout --` after each and confirmed **byte-identical** to the
committed version (`diff -q`), with `git status --porcelain` clean. Both the stale-number path and the
silent-deletion path are now genuine build failures.

## 11.4 The one skipped test — investigated, not waved through

`npm run check` reports `pass 2113 · skipped 1` this round, where rounds 1 and 2 reported
`pass 2114 · skipped 0`. Since a changed count is exactly what a regression looks like, it was run down
rather than accepted:

- The test is `migrations.test.ts` › *"a real profiles/rajni fixture db (copied to a temp path) upgrades
  v6 -> LATEST_SCHEMA_VERSION without data loss"*.
- Its skip is **declared and opportunistic by design**: `skip: existsSync(RAJNI_FIXTURE_DB) ? false : …`,
  with the file's own comment stating it "runs wherever the file happens to be present, and skips
  cleanly everywhere else (a fresh checkout, CI), rather than depending on undeclared local state."
- Re-run directly on this HEAD it **passes**: `node --test src/adapters/db/sqlite/store/migrations.test.ts`
  → `tests 19 · pass 19 · fail 0 · skipped 0`, with the test itself reported `✔`.
- `fail 0` in every case. Cause is the gitignored fixture DB's momentary absence during the gate run
  (this session re-seeds it between rounds), not the commit under test — which touches no `src/` code
  at all.

**Verdict: not a regression.** Recorded here rather than omitted, because a silently-changed test count
is precisely the kind of thing a green tick hides.

## 11.5 Bug List — ROUND 3

**None.** R2-1 is **CLOSED**. Zero open bugs across all three rounds.

## 11.6 Deferred

**None.** No bug was deferred in any round. Deferral is the user's decision alone, relayed through the
orchestrator; all three rounds ran unattended, so no such approval exists or was assumed.

## 11.7 Residual Risk — final

Green means **"no known defects," never "no defects."** Three rounds found 11. That the third round
found none is weak evidence about the fourth. What remains untested or unverifiable:

1. **R2-1's own root cause is closed, but the class it belonged to is only narrowed.** The contrast
   table is now the single source and cannot drift — but the same parallel-maintenance shape still
   exists elsewhere: `RESERVED_WORDS` and `TEXT_RAMP` in `tokens.test.ts` are hand-written lists checked
   *against* `reference.md`, not derived *from* it. A reserved word dropped from both at once passes.
2. **The four FAIL rows are guarded by numeric pinning only.** A row whose markdown *formatting* changed
   would fall out of the regex and stop being checked; `REQUIRED_PASS_PAIRS` guards the 9 `pass` rows
   against exactly this, but the fill-only rows have no such name-level guard. No AA implication —
   they are documented as never used for text.
3. **Contrast is verified at the token level, not the rendered level.** Both my check and the repo's read
   hex pairs from `index.css`. Neither catches a component that composes a text colour over an
   *unexpected* background, or opacity-modified utilities (`bg-success/10`) whose effective contrast
   differs from the token pair.
4. **Carried forward, still open:** spec §15's named riskiest assumption (R13's 281-file sweep, verified
   by screenshot and bounded-type-ramp extraction across 7 routes, not by per-screen pixel diff against
   the pre-change UI); `runs`' `laneLabel()` call sites never rendered live (they need a failed run; the
   fixture has none); archived state reachable only via an exclusive filter, so mixed-list archived
   behaviour is untestable by design; and round 1's auto-advance retargeting, an accepted deviation
   behaving as ruled.
5. **Nothing here shows the feature serves the user.** A complete matrix is not evidence that the
   rebuilt triage pane shortens the decide loop. Spec §14 declined the instrumentation and §15 weakness 5
   concedes it: metric 3 stays observed, not measured, at n=1.

## 11.8 Final Verdict

**GREEN — zero open bugs.** All 15 acceptance criteria delivered, all 20 MoSCoW Musts delivered, all 48
mockup ids and all 12 frames accounted for, all four gates green, 135 e2e specs passing, and the three
accepted-deviation rulings recorded rather than absorbed. PR opened; **merging remains the user's
decision.**
