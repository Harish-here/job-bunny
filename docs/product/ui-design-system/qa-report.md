# QA Report — UI Design System & Triage Job-Details Overhaul

**Verdict: RED — 10 open bugs (0 critical · 1 major · 9 minor). No PR opened.**

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
| 1 | Colour: every text pair ≥ 4.5:1 both modes; check **automated**, failing pair = **build failure** | **DRIFTED** | Ratios independently recomputed by me from `index.css` (WCAG relative-luminance): **every text pair passes in both modes** (light 5.25–12.43:1; dark 5.95–13.63:1); `reference.md`'s table is accurate. But **no code computes a contrast ratio** — `tokens.test.ts` only pins hex strings. → **Bug 8** |
| 2 | Type scale as tokens; no `text-[Npx]` anywhere; every step used | **DELIVERED** | `grep -rn 'text-\[' ui/src` → 1 hit, `text-[0.8rem]` in vendored `button.tsx` (rem, not `Npx`, pre-existing). All five `text-[10px]`/`text-[9px]` eliminated. Live measurement across all 7 routes: **only 11/12/14/16/18/24px, zero off-scale** (`sweep-report.md` Part 3) |
| 3 | Voice rules documented; every new/changed button label imperative + sentence case | **DELIVERED** | New labels: Apply · Lead · Pass · Try again · Show full description · Show less · Clear filters · View the tracker → — all imperative, sentence case. `reference.md` §Voice |
| 4 | Exactly one word per concept; banned synonym fails the build | **DELIVERED** (with note) | `bannedSynonyms.test.ts` walks the whole `ui/src` tree and asserts no match against 3 precise patterns. Note: the scan runs under `ui:check`, not `npm run check` — the repo's own architecture puts `ui/` outside the root gate, so the AC's literal wording is unimplementable; CI runs both |
| 5 | `tokens.test.ts` pins every token in the reference doc, both modes; no new dependency | **DELIVERED** | +71 lines pinning `--text-micro`, the 6-step ramp, and 30+ reserved words against `reference.md`; `git diff origin/main...HEAD -- ui/package.json` is **empty** |
| 6 | All eight screens import type tokens **and the vocabulary module**; full e2e green; no layout change outside triage/`#/job/:id` | **DRIFTED** | Type tokens: **all 8** (live-measured). Vocabulary module: **4 of 8** — only triage, job, settings import `lib/vocabulary`; tracker, runs, analytics, Operate, onboarding do not. e2e green (127/127); no non-triage layout change observed across 7 route screenshots. → **Bug 9** |
| 7 | Pane order: score+scale → reasons/flags distinct → eligibility → lane → JD disclosed → tracking last | **DELIVERED** | Script-extracted DOM order matches the mockup **exactly** (`style-diff.md`): `verdict-header → match-score → score-meter → provenance-line → lane-label → signals → match-reasons → eligibility → skills → jd → jd-toggle → tracking → decide-bar`. Reasons = green rounded chips + check icon, wrapped horizontally; flags = 2px red left rule + triangle icon, stacked vertically — distinct by container shape, icon and rhythm, not hue (`stub-detail-pane.png`) |
| 8 | Buttons read "Pass"/"Lead"; badge uses the button's word; `a`/`x`/`s` work; hints match | **DELIVERED** | Live: clicked Pass → badge flipped to `Passed`, `aria-pressed=true`; buttons render `Apply a` / `Lead s` / `Pass x`. Keys pinned by `smoke.spec.ts:73-83` + `:86-97` (both green) |
| 9 | No raw lane identifier in any user-visible string | **DELIVERED** | Live snapshots show `LinkedIn` / `Greenhouse` throughout list and pane. `laneLabel()` maps all three |
| 10 | No state distinguishable by hue alone | **DELIVERED** | `StatusPip` renders 5 distinct lucide shapes + `aria-label` (`Circle`/`Star`/`Send`/`Minus`/`ChevronsRight`); score carries band word + bar meter + weight; flags vs reasons differ by container. Verified in `qa-S1-app.png` |
| 11 | No raw unicode glyph used as an icon in `ui/src/**` | **DRIFTED** | Triage glyphs replaced with lucide and gated by `/[✓✗☆↑↓]/`. But `⚡` (U+26A1) still renders as an icon at `tracker/DueStrip.tsx:29`, uncovered by the pattern. → **Bug 10** |
| 12 | `#/job/:id` renders correctly, same field ordering as the triage pane | **DELIVERED** (with note) | Renders clean, zero console errors (`screen-job.png`). Right-column zone order matches triage (`signals → eligibility → skills → tracking`); JD sits in the left column, so absolute DOM order differs — forced by the pre-existing 2-column grid that R33 (Won't) protects, and reasoned explicitly in blueprint §3. Not filed as a bug; see Notes |
| 13 | Detail pane uses shared `Card`; no triage action uses `variant="destructive"` | **DELIVERED** | `DetailPane.tsx` wraps in `<Card>`; `decide-pass` is `variant="outline"`. `grep destructive ui/src/features/triage/DecideBar.tsx` → no hit |
| 14 | Board still `127.0.0.1`-only; no new route, request field or DB column; only job write stays the tracking PATCH | **DELIVERED** | `git diff origin/main...HEAD -- src/ test/` is **empty**. Live: the only PATCH observed was `/api/profiles/rajni/jobs/:id/tracking` |
| 15 | `npm run check` + `npm run ui:check` pass; no file over the 400-line cap | **DELIVERED** | Both green (§2). Cap test green inside gate 1; independent `wc -l` sweep of `ui/src` found zero impl file > 400 and zero test file > 800 |

**AC totals: 11 delivered · 4 drifted · 0 missing · 0 untested.**

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
| R13 eight screens adopt tokens + vocabulary | **drifted** | tokens yes (all 8, live-measured); vocabulary module 4 of 8 → **Bug 9** |
| R14 five off-scale values eliminated | delivered | zero `text-[Npx]` remain |
| R15 state never colour-alone | delivered | shape + icon + text cues verified in screenshots |
| R17 pane ordered by decision | delivered | DOM order matches mockup exactly |
| R18 score labelled + scaled | delivered | `MATCH / 95/100 / ▮▮▮▮ STRONG` |
| R19 reasons vs flags visually distinct | **untested end-to-end** | Correct when rendered (stubbed evidence), but **no fixture produces `reviewFlags`** → **Bug 1** |
| R20 lane surfaced by display name | delivered | `LinkedIn` / `Greenhouse` in pane and rows |
| R21 JD measure-capped + disclosed | delivered | live: clamp + fade + `Show full description` ⇄ `Show less`, session-sticky across job selection |
| R24 `#/job/:id` verified | delivered | renders clean; see AC 12 note |
| R25 existing e2e selectors keep passing | delivered | 127/127 e2e green |

**Must totals: 18 delivered · 1 drifted · 1 untested-end-to-end · 0 missing.**

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

## 5. Bug List

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

**RED — 10 open bugs (0 critical · 1 major · 9 minor). No PR opened.**

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
