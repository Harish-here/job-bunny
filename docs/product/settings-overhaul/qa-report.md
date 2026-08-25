# QA Report — Settings & Control Surface Overhaul

Stage: product-qa · round 1 2026-08-25 · re-verified round 2 (HEAD `5394bdc`) ·
**re-verified round 3 2026-08-25 (HEAD `4615f85`)**

**VERDICT: GREEN — 0 open bugs.** No PR opened (the round-3 brief explicitly withheld it).
*Round 1 filed 10 · round 2 closed 7 and filed 4 more (7 open) · **round 3 closes all 7 and files none**.*

---

## 0. Re-verify — 2026-08-25 (round 3)

Re-verified at HEAD `4615f85` after two fix commits (`54a3862`, `4615f85`). Same worktree
(`/Users/harishamutha/jb-wt-settings`), same `rajni` fixture, same viewport (1440×900), board on
`--port 4200` after `npm run ui:build`, stopped at end of round. Method matched rounds 1–2:
computed styles and DOM counts extracted **by script**, screenshots only where extraction cannot
decide — and every screenshot captured was read.

**Round-3 verdict: GREEN — 0 open bugs (0 critical / 0 major / 0 minor).** All four gates pass and
`npm run ui:e2e` is green on **three consecutive runs at the default invocation**.

| Round-2 bug | Sev | Round-3 status | One-line evidence |
|---|---|---|---|
| **B11** `ui:e2e` red at default parallelism | critical | **CLOSED** | 3/3 green: `53 passed` (shared-docs, 1 worker) + `64 passed` (default, 4 workers) = **117 tests**, identical all three runs. All **18/18** spec files ran — no file orphaned by the two-project split |
| **B9** S4 + S5 loading states | major | **CLOSED (both halves)** | S4: `roles-companies-skeleton` = 1, **12** `[data-slot="skeleton"]`, `"Loading…"` **absent**. S5: judged delivered against §12's intent — see the ruling below |
| **B6** missing-secret destination inert | minor | **CLOSED** | Label now **"Secrets"**; after click `activeElement` = `BUTTON "Set"` with `activeInsideSecrets: true`; at **1440×600** the card is genuinely below the fold (`y=642 bottom=802 vh=600`) and the control scrolls it fully in (`y=416 bottom=576`) |
| **B8** Fast preset accent missing | minor | **CLOSED** | All four edges exact vs mockup: left `2px rgb(255,138,61)`, other three `1px rgb(228,219,240)`. Warning tint composites **pixel-identically** to the mockup |
| **B12** ValidationSummary drift | minor | **CLOSED** | Container matches on **every** measured property; max field now carries its own sentence; inline errors are short and per-field |
| **B13** `--destructive` fails 4.5:1 as text | minor | **CLOSED** | Summary links, inline `FieldError` and `daemon-state` all compute `rgb(198,44,44)` → **5.53:1** on white. ux-notes §14 amended by the advisor's ruling |
| **B14** two §12 states unowned at e2e | minor | **CLOSED** | `scheduled-runs-empty` → `operate.spec.ts:408-410` (text-asserting); `raw-editor-skeleton` → `settings.spec.ts:242-249` (visible **and** `height > 400`) |

**New bugs this round: none.** Two candidate findings were investigated and resolved as
non-defects — both are in NOTES with their evidence.

### 0.1 Gate results (round 3, verbatim)

**All four gates PASS.** Logs under `scratchpad/gate-*.log`.

| Gate | Result | Counts | Wall |
|---|---|---|---|
| `npm run check` | **EXIT 0** | `tests 2114 / pass 2114 / fail 0` | 11.29s |
| `npm run ui:check` | **EXIT 0** | `Test Files 117 passed (117)` · `Tests 1024 passed (1024)` (28 lint warnings, 0 errors) | 17.85s |
| `npm run ui:build` | **EXIT 0** | built in 267ms (chunk-size warning only) | 0.63s |
| `npm run ui:e2e` ×3 | **EXIT 0 ×3** | see below | 28.49s / 27.85s / 27.68s |

```
run 1:  Running 53 tests using 1 worker     ->  53 passed (16.5s)   [shared-docs]
        Running 64 tests using 4 workers    ->  64 passed (10.9s)   [default]
run 2:  Running 53 tests using 1 worker     ->  53 passed (15.9s)   [shared-docs]
        Running 64 tests using 4 workers    ->  64 passed (10.8s)   [default]
run 3:  Running 53 tests using 1 worker     ->  53 passed (15.7s)   [shared-docs]
        Running 64 tests using 4 workers    ->  64 passed (10.8s)   [default]
```

**B11's fix was audited, not merely observed green.** Two ways a project split can lie were checked
directly: (a) a name in `SHARED_DOC_SPECS` that matches nothing would be excluded from `testMatch`
**and** `testIgnore`, silently running in neither project — `comm` of the 18 `ui/e2e/*.spec.ts` files
on disk against the files appearing in the run log returns **empty**, so all 18 ran; (b) the two
projects run as two sequential `playwright test` invocations joined by `&&`, so a shared-doc writer
can never overlap a `default`-project spec at all — the isolation is stronger than serialising
within one run.

### 0.2 The B9(b) design call — adjudicated, as the brief asked

ux-notes §12, S5 Loading: *"textarea skeleton at same height (**no layout shift**)"*. The implementer
states exact matching is unachievable under `field-sizing: content` and sized the skeleton to the
available column (`min-h-[70vh]`) instead. **QA's ruling: acceptable — the clause's intent is met.**
Measured at 1440×900, `profile.json` (the only doc reachable at first mount):

| Landmark | Loading | Resolved | Movement |
|---|---|---|---|
| `raw-scope-banner` y | 128 | 128 | **0px** |
| `raw-doc-list` y | 200 | 200 | **0px** |
| all 5 `raw-key-badge-*` y | 206,206,242,242,350 | 206,206,242,242,350 | **0px** |
| editor box top y | 222 | 222 | **0px** |
| editor box height | 630 (skeleton) | 2166 (textarea) | +1536px, downward |
| scroll container (`main`, `overflow-y:auto`) `scrollHeight` | 846 | 2382 | +1536px (`clientHeight` fixed at 808) |

Reasoning: **not one visible element moves.** The whole delta is the scroll container's *extent* —
the scrollbar thumb resizes; nothing under the user's eye shifts, which is the harm the clause
exists to prevent. The skeleton fills 630 of the 808px visible column (78%), so the loading state
reads as "a large editor is coming" rather than the round-2 `h-80` box that undersold it. The
opposite failure — a **short** doc resolving *upward* under a tall skeleton — was probed and is
**unreachable**: `search_urls.md` renders at 466px (164px shorter than the skeleton), but a doc
**switch never re-shows the skeleton** (measured `mid{skel=null}` on all four docs; data is already
resident), and first mount is always `profile.json`. The e2e now guards the floor
(`height > 400`), so it cannot silently regress to `h-80`.

### 0.3 Regression spot-check — round-1/2 fixes all hold

| Item | Round-3 evidence |
|---|---|
| **B1** summary at top, save control stays mounted | `validation-summary` rect `{x:496, y:128, w:896, h:100}`; across the failed submit `save-bar/save-button/discard-button` = `1/1/1`, `saveDisabled: false`; `activeElement` = the summary |
| **B2** summary links focus real fields | clicking the first link → `activeElement` = `INPUT#fetching.jitterMinMs` |
| **B3** copy names both fields, values, consequence | *"Minimum jitter (99999 ms) is above maximum jitter (12000 ms). The run would fail to start."* |
| **B4** danger-zone render contract | at `#/settings/danger`: `danger-zone`=1, `danger-open`=1; after opening, `danger-confirm-input`=1, `danger-remove-button`=1, disabled; a wrong name (`not-rajni`) leaves it disabled; Escape closes. **Nothing deleted** |
| **B5** Scheduled-runs empty state | `scheduled-runs-empty`=1, *"No scheduled runs — enable a schedule in Settings → Schedule."*, `schedule-row-*`=0 |
| **B7** daemon status word contrast | `daemon-state` = `rgb(198,44,44)` 14px/500 → **5.53:1** on white, **4.59:1** on the card tint — above 4.5:1 on either |
| **B10** save model pinned at e2e | `settings-save-model.spec.ts` runs in the serial `shared-docs` project; green in all three runs |
| **Operate renders four cards** | `["card-daemon","card-scheduled-runs","card-setup-health","card-secrets"]`, in that DOM order — parked-slice ruling honoured |

### 0.4 Interaction sweep (Operate, 1440×900)

21 interactive controls enumerated; each clicked with the accessibility-shaped DOM snapshot diffed
before/after. **Every control produced a delta** except two, both correctly inert:

- `Operate` in the sidebar — the nav item for the page already open (hash unchanged by design).
- `Run now` — see NOTES; it is **not** inert, it created run intent `127` (cancelled by QA
  afterwards) and relabels itself, which is why a role lookup for "Run now" then missed it. It is
  also pre-existing `ui/src/features/runcontrol/`, outside this epic.

`Start` / `Pause all` / `Autostart` / `Copy: jobbunny serve start` were deliberately **not** clicked
(§7.1). No console or page errors fired during the sweep.

### 0.5 Coverage after round 3

- **ux-notes §12 five-state matrix: 26 delivered · 0 drifted · 1 untested** (round 2: 24/2/1;
  round 1: 22/4/1). The single remaining `untested` is S9 Danger-zone **Error** (the 409
  `run_in_progress` / `intent_pending` branch), unchanged and unclaimed since round 1.
- **MoSCoW:** every Must is **delivered** except R17/R18 (**parked** by closed ruling) and R19/R20's
  live effects (**untested**, §7.1). R22 moves **drifted → delivered** with B6's closure.
- **Acceptance criteria:** AC20 moves **drifted → delivered**. AC17 remains **untested**; AC15/AC16
  remain **out of scope**. All others delivered.
- **E2E: 18 spec files, 117 tests** (round 2: 18 / 114). No `data-qa` named by the blueprint's §e2e
  Disposition Ledger is now unowned.

### 0.6 Fixture integrity

`git status --short` in the worktree shows only the untracked `qa-report.md`; `git status --short
profiles/` is **empty**. The one side effect QA created (pending run intent `127`, from the
interaction sweep) was cancelled through the board's own cancel-own-pending route and verified
`status: "cancelled"`. `/Users/harishamutha/Job-bunny` was never written to and its `git status` is
clean; the Playwright-MCP snapshot it produced during the prerequisite check was deleted along with
its directory. `profiles/harish/` and `~/.jobbunny` were never read or written.

---

## 0b. Re-verify — 2026-08-25 (round 2) — superseded by §0, kept as the trail

Re-verified at HEAD `5394bdc` after two fix commits (`698adea`, `5394bdc`). Same worktree,
same fixture, same viewport; board on `--port 4200` (4199 was held by the e2e gate for the whole
session, so the non-default port was reused from round 1). Method matched round 1 — computed styles
and DOM counts extracted by script, screenshots only where extraction cannot decide.

**Round-2 verdict: RED — 7 open bugs (1 critical / 1 major / 5 minor).** Seven of the ten round-1
bugs are closed on live evidence. Three remain open (one of them because the round-1 fix
over-corrected), and four are new — one of which is a red CI gate.

| Round-1 bug | Status | One-line evidence |
|---|---|---|
| B1 save feedback below the fold, bar unmounts | **fixed** | `validation-summary` rect `y=128 h=80` (top of the content column, `settings-section` starts at `y=128`), `save-bar`/`save-button`/`discard-button` counts stay `1/1/1` across the failed submit, `activeElement` = the summary |
| B2 summary links inert | **fixed** | input ids are now the error keys (`fetching.jitterMinMs`); clicking the first link leaves `activeElement` = `INPUT#fetching.jitterMinMs` |
| B3 copy drops the consequence | **fixed** | *"Minimum jitter (99999 ms) is above maximum jitter (12000 ms). The run would fail to start."*; singular/plural correct (`1 problem to fix` observed live on the raw-config parse error) |
| B4 danger-zone `data-qa` ids | **fixed** | `danger-zone` = 1; after opening, `danger-confirm-input` = 1, `danger-remove-button` = 1 |
| B5 Scheduled runs empty state | **fixed** | `scheduled-runs-empty` = 1, *"No scheduled runs — enable a schedule in Settings → Schedule."*; the row-describing footer is gone |
| B6 missing-secret destination | **still open** | destination now says "Operate" — but it is the page you are already on, and the control is inert (see B6) |
| B7 daemon status word contrast | **fixed** | `daemon-state` = `rgb(198,44,44)` → **5.24:1** on the composited card background (5.53:1 on white). The ux-half it flagged is still open → B13 |
| B8 Fast preset border | **still open (over-corrected)** | the `--attention` accent is now absent entirely; the mockup puts it on the **left edge only** |
| B9 loading skeletons | **partially fixed** | S2 ✓ (13 skeletons) S3 ✓ (18) — S4 still bare "Loading…", S5 skeleton 320px vs a 2186px textarea |
| B10 save model has no e2e | **fixed** | `settings-save-model.spec.ts`, 4 effect-asserting tests; all four ids now pinned. **But it triggered B11** |

**New this round:** B11 (critical — `ui:e2e` red on every parallel run), B12 (ValidationSummary
drifts from mockup S8), B13 (the ux ruling B7 asked for, now shipping in the error summary),
B14 (the B5 fix's §12 state has no e2e owner).

---

## 1. Scope Digest

| | |
|---|---|
| Repo / worktree | `/Users/harishamutha/jb-wt-settings` (never touched `/Users/harishamutha/Job-bunny`) |
| Branch | `feat/settings-overhaul-impl` |
| HEAD verified | round 1 `c5975d05624336bb4a7054d245c9c1d2f5bd8b91` · round 2 `5394bdc656ea854cf32565bfb9f69a11e32dbf52` · **round 3 `4615f859b623c08a373d904ad12b5d6813d23e40`** (each matches the expected HEAD for its round) |
| Working tree | clean at start and at end of all three rounds. `git status --short profiles/` empty at end of round 2 — the `rajni` fixture was verified untouched after every probe that wrote through the board API |
| Data home | `JOBBUNNY_HOME=$PWD` (the worktree), profile `rajni` fixture only. `profiles/harish/` and `~/.jobbunny` were never read or written. |
| App under test | `JOBBUNNY_HOME=$PWD node src/cli/main.ts board --port 4200` after `npm run ui:build`, stopped at end of round. Port 4200 throughout (4199 is bound by `ui/playwright.config.ts` with `reuseExistingServer: false`); round 3's brief specified 4200 directly. The live board on 1994 was never touched. |
| Viewport | 1440×900 for both the built app and `mockup.html` |

Artifacts used as the oracle, all under `docs/product/settings-overhaul/`:
`spec.md` (§11 Requirements, §13 Acceptance Criteria) · `ux-notes.md` (§11 save model, §12 five-state
inventory, §14 accessibility, §17 `data-qa` render contract) · `mockup.html` (10 screens, 89 unique
`data-qa` ids) · `blueprint-be.md` (§11/§11a dispositions) · `blueprint.md` (§1 component mapping,
§4 implementation steps, §9 dispositions, §e2e Disposition Ledger) · `rulings/`.

**Closed rulings honoured, not re-litigated:** R20 = Option 1 (board-initiated detached daemon
spawn); "Operate" rename; F10; wizard entry on Operate; **the LinkedIn session-health slice is
PARKED** — Operate renders FOUR cards and `card-linkedin` / `linkedin-*` / `daemon-start-fallback`
are absent by design, so AC15 and AC16 are out of scope, not missing. `CLAUDE.md:119` write-surface
wording is deferred to the user and was not assessed. `rulings/ui-impl-gate-r1.md`'s F4 and F5 are
accepted residuals and are not filed as bugs; its blocking F1/F2/F3 were verified closed by commit
`20820f0` (`ScheduleSection.tsx:91` now calls `guardedNavigate`; a provider-mounted test was added;
`.state.md:604` now reads "7 of the 10").

---

## 2. Gate Results (verbatim)

> **Superseded by §0.1.** At round 3 (HEAD `4615f85`) **all four gates PASS** and `npm run ui:e2e`
> is green on three consecutive runs at the default invocation. The round-2 text below is kept
> verbatim as the trail of what was red and why.

**Round 2 (2026-08-25, HEAD `5394bdc`): three of four gates PASS. `npm run ui:e2e` is RED —
it failed on three consecutive runs with a different failure set each time.**

### `npm run check` — EXIT 0

```
ℹ tests 2114
ℹ suites 10
ℹ pass 2114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9194.517208
```

### `npm run ui:check` — EXIT 0, 17.57s

```
 Test Files  117 passed (117)
      Tests  1020 passed (1020)
   Start at  04:35:05
   Duration  13.50s
```

(28 lint warnings, 0 errors — warnings do not fail the gate. The `SkillsSection.tsx` `minMatch`
flake the brief named did not fire in either run.)

### `npm run ui:build` — EXIT 0, 0.63s

```
✓ built in 254ms
(!) Some chunks are larger than 500 kB after minification.
```

### `npm run ui:e2e` — **EXIT 1 on run 1, EXIT 1 on the rerun, EXIT 1 on a third run**

Run 1 — **3 failed / 111 passed**:

```
  1) [chromium] › e2e/settings-save-model.spec.ts:103:1 › settings save model: dirty-nav-dialog
     "Save and continue" navigates and persists the value
    Error: expect(received).toBe(expected)   Expected: 11   Received: 7
      125 |     expect(await fetchCheckpointsOlderThanDays(page)).toBe(11);

  2) [chromium] › e2e/settings-where-you-work.spec.ts:40:1 › settings: where you work notice names
     the unlisted timezone on a hard conflict
    Error: expect(locator).toContainText(expected) failed
    Expected substring: "America/New_York"
    Received string:    "APAC is ranked as acceptable, but your rule drops remote roles outside …"

  3) [chromium] › e2e/settings.spec.ts:57:1 › settings: where jobs come from section round-trips a
     lane toggle through the server
    Error: expect(locator).toBeChecked() failed   Expected: checked   Received: unchecked
```

Rerun — **2 failed / 112 passed**, a *different* set:

```
  1) [chromium] › e2e/operate.spec.ts:418:1 › operate-schedule: schedule-skip-next writes
     {date, slot} matching the stubbed next run, and shows the success chip
    Error: expect(received).toEqual(expected)
    Expected: {"date": "2026-08-25", "slot": "23:59"}   Received: undefined

  2) [chromium] › e2e/settings-save-model.spec.ts:58:1 › settings save model: editing a field shows
     save-bar, Save shows save-success-line, and the value round-trips through the server
    Error: expect(received).toBe(expected)   Expected: 7   Received: 2
```

Third run — **1 failed / 113 passed** (`operate.spec.ts:418` again).

**Diagnostic (not a fix — QA is read-only):** the same suite at one worker is green.

```
$ cd ui && npx playwright test --workers=1
  114 passed
EXIT=0
```

Playwright uses **4 workers** here (8 CPUs; `ui/playwright.config.ts` sets no `workers`, no
`fullyParallel`, and no spec uses `test.describe.serial`). **Eight** spec files read-modify-write the
same shared `rajni` `profile.json` through the board API and each restores its own captured
`original` in a `finally`: `operate`, `settings`, `settings-delivery`, `settings-fetching`,
`settings-housekeeping`, `settings-roles-companies`, `settings-where-you-work`, and — new in
`5394bdc` — `settings-save-model` (4 writes). See **B11**.

**Totals: 2114 + 1020 unit/integration; 114 e2e (serial) — 0 lasting failures at one worker,
1–3 failures on every parallel run.**

Logs: `scratchpad/rq-gate-check.log`, `rq-gate-ui-check.log`, `rq-gate-ui-build.log`,
`rq-gate-ui-e2e.log`, `rq-gate-ui-e2e-rerun.log`, `rq-e2e-run3.log`, `rq-e2e-serial.log`.

<details><summary>Round 1 gate results (2026-08-25, HEAD <code>c5975d0</code>) — all four green</summary>

`npm run check` EXIT 0 (2114 tests) · `npm run ui:check` EXIT 0 (115 files / 1001 tests) ·
`npm run ui:build` EXIT 0 · `npm run ui:e2e` EXIT 1 on run 1 (109 passed / 1 failed at
`settings.spec.ts:57`), **EXIT 0 on the rerun (110 passed)**. The single round-1 flake was the same
shared-fixture race that is now B11 — it cleared on one rerun then, and clears on no rerun now.

</details>

## 3. Traceability Matrix

### 3.1 MoSCoW requirements

| Req | MoSCoW | Verdict | Evidence |
|---|---|---|---|
| R1 intent-named sections | Must | **delivered** | 12 nav labels, none named after a file (live snapshot of `settings-nav`) |
| R2 one intent spanning two docs | Must | **delivered** | Live: rules card + prefs card + `geo-connective-line` on one screen; conflict notice fires with two working one-click fixes (§3.4) |
| R3 scope stated | Must | **delivered** | `scope-chip-profile` "Profile: rajni" / `scope-chip-machine` "This machine · all profiles"; profile switch leaves daemon + secrets unchanged |
| R4 one Advanced/raw area | Must | **delivered** | `raw-doc-list` (4 docs), `raw-editor`, `raw-scope-banner`, 5 `raw-key-badge-*`; badge click navigates to the owning form (`raw-config` → `schedule`) |
| R5 no silent discard | Should | **delivered** | Live: dirty-nav dialog fires; "Stay" keeps the draft; a second nav click is blocked by the modal. Untested at e2e — see B10 |
| R6 yield caps surfaced | Must | **delivered** | All four caps editable with their one-line statements (§3.2 AC6) |
| R7 companies + timezones forms | Must | **delivered** | `companies-avoid-card`, `geo-timezones-rule`; round-trip pinned by `settings-where-you-work.spec.ts` |
| R8 retunable lists, no point weights | Must | **delivered** | Skills/prefs forms carry no `maxPoints`/denominators; "Point weights for these live in Raw config →" |
| R9 mirror + dryRun toggles | Must | **delivered** | `delivery-notion-mirror`, `delivery-notion-dry-run` |
| R10 cleanup TTLs | Should | **delivered** | Housekeeping renders "Runs older than (days)" + checkpoint TTL |
| R11 connector read-only | Must | **delivered** | 0 interactive controls inside `delivery-connector-card`; copy names the migration |
| R12 pacing presets + disclosure | Should | **delivered** | 3 presets with consequences, `pacing-fast-warning` + `pacing-fast-ack`, `pacing-advanced-disclosure` with 4 raw fields |
| R13 no wire-time-invalid save | Must | **delivered** (round 1: drifted) | Rejection works, the button is never disabled, the summary renders at the top of the content column and takes focus, its links focus the real fields, and the copy names both fields, both values and the consequence. B1/B2/B3 all closed. Residual styling/copy drift against mockup S8 is **B12**, which does not affect R13's own clause |
| R14 states when it takes effect | Must | **delivered** | Exact ux-notes copy: "Saved. Takes effect from your next run — nothing is running right now." |
| R15 rule preview | Should (conditional) | **delivered** | Spike shipped; `rule-preview-strip` renders "No recent run to preview against." — the designed (b) state for a fixture with no runs |
| R16 daemon on an ops surface | Must | **delivered** | `card-daemon`: state word, last tick, pid, uptime |
| R17 LinkedIn session health | Must | **parked** | Closed ruling — out of scope, not a defect |
| R18 breaker state | Must | **parked** | Parked with the LinkedIn slice |
| R19 pause / resume / skip-next | Must | **untested (live)** | Controls render; mutations pinned by `operate.spec.ts:418,474`. No running daemon existed and starting one was deliberately declined (§7) |
| R20 daemon lifecycle control | Must | **delivered (control)** / **untested (effect)** | `Start`, `Pause all`, `Autostart` render. Start and Autostart were NOT clicked (§7) |
| R21 doctor from the ops surface | Should | **delivered** | `card-setup-health` groups 3 needs-action + 1 not-configured + 7 OK |
| R22 setup completeness | Must | **drifted** (unchanged) | Groups and destinations render. The missing-secret destination no longer points at a page with no token field, but it now points at the page it is already on and is inert (**B6**) |
| R23 no Claude-dependent work in the board | Must | **delivered** | `checkDestination.ts` has no adopt-or-create/PDF route; `daemon-liveness` hands off `jobbunny serve start` via a working copy button |
| R24 write-only secrets | Must | **delivered** | `GET /api/secrets` → `{"NOTION_TOKEN":"absent","TELEGRAM_BOT_TOKEN":"absent"}` |
| R25 proportional friction | Should | **delivered** | Type-to-confirm kept; no confirm on any reversible edit |
| R26 settings search | Could | **not delivered (by decision)** | `settings-search` absent; blueprint.md §NOTES records the non-promotion and its condition. Recorded, not a defect |
| R27 reset-to-default | Could | **not delivered** | Out of the shipped phases |
| R28–R32 | Won't | **correctly absent** | No breaker reset control, no autosave, no connector control, no Telegram digest config |

### 3.2 Acceptance criteria (spec §13)

| # | Req | Verdict | Note |
|---|---|---|---|
| 1 | R1 | delivered | Section labels inspected live |
| 2 | R2 | delivered | Both halves on one screen, difference stated by `geo-connective-line` |
| 3 | R3 | delivered | Machine-scoped values unchanged across a profile switch |
| 4 | R4 | delivered | Pinned by `settings.spec.ts:175,218,295,322,339` |
| 5 | R5 | delivered | Live-verified; no e2e (B10) |
| 6 | R6 | delivered | All four caps + statements render live |
| 7 | R7 | delivered | Form → `GET config/filter.json` round-trip pinned |
| 8 | R8 | delivered | Skill point weights absent from every form |
| 9 | R9 | delivered | Both toggles present |
| 10 | R11 | delivered | Read-only display + reason |
| 11 | R13 | **delivered** (round 1: drifted) | Rejected at save ✓, both fields named ✓, values and consequence named ✓, button never disabled ✓, summary at top ✓, focus moves ✓, links focus the fields ✓ |
| 12 | R14 | delivered | Exact designed copy |
| 13 | R15 | delivered | Spike passed; strip present in its designed empty state |
| 14 | R16 | delivered | Visible without opening a form |
| 15 | R17 | **out of scope** | PARKED by closed ruling |
| 16 | R18 | **out of scope** | PARKED by closed ruling |
| 17 | R19 | **untested** | Requires a running daemon — deliberately not started (§7) |
| 18 | R20 | delivered (control) | Start control present; live start not exercised (§7) |
| 19 | R21 | delivered | One action from Operate |
| 20 | R22 | **drifted** (unchanged) | See B6 — the destination is now correct but the control is inert |
| 21 | R23 | delivered | No board route performs either |
| 22 | R24 | delivered | Presence-only response |
| 23 | R25 | delivered | Confirm button disabled until the exact name is typed |
| 24 | **Regression** | delivered | `lsof` → `TCP 127.0.0.1:4200 (LISTEN)` only; `curl http://192.168.1.6:4200` → `000` (unreachable). No route spawns a run; run intents remain insert-only |

### 3.3 ux-notes §12 — five states, every screen

27 content-bearing cells (n/a cells excluded). **Round 3: 26 delivered · 0 drifted · 1 untested**
(round 2: 24 / 2 / 1 · round 1: 22 / 4 / 1). The two round-2 `drifted` cells — S2/S4 **Loading** and
S5 **Loading** — are both delivered at round 3 (B9, §0.2). The lone `untested` cell is S9
Danger-zone **Error**.

| Screen | Default | Empty | Loading | Error | Success |
|---|---|---|---|---|---|
| S1 landing | delivered | delivered (`landing-thin-run-empty`) | delivered (e2e :178) | delivered (e2e :225) | delivered |
| S2 / S4 rule sections | delivered | delivered (e2e) | **drifted (B9 — S2 fixed, S4 still bare "Loading…")** | delivered (live) | delivered (live) |
| S3 Fetching | delivered | n/a | **delivered** (was B9 — 18 skeletons, no "Loading…") | **delivered** (was B1/B2/B3; residual styling drift = B12) | delivered (live) |
| S5 Raw config | delivered | delivered (e2e :322) | **drifted (B9 — skeleton 320px vs a 2186px textarea, +1594px shift)** | **delivered, live-verified this round**: *"1 problem to fix / Invalid JSON (line 1): Expected double-quoted property name in JSON at position 8 (line 1 column 9)"*, `save-bar` stays mounted, Discard restores byte-identical text, server doc unchanged | delivered |
| S6 / S7 Operate | delivered | **delivered (was B5)** — but no e2e owner (**B14**) | delivered (e2e :347) | delivered (`api-unreachable`, e2e :331) | delivered (e2e :418) |
| S9 Danger zone | delivered | n/a | n/a | **untested** (409 `run_in_progress`/`intent_pending` implemented at `DangerZone.tsx:47,76-77`; no test drives it) | delivered (`profile-lifecycle.spec.ts:157`) |

### 3.4 Hero states, live-verified

- **R2 conflict notice (C4 — the epic's headline payoff): works exactly as designed.** Adding
  `AMER` to `geo-timezones-acceptable` fires `geo-conflict-notice` reading *"AMER is ranked as
  acceptable, but your rule drops remote roles outside the allowed timezones — so no job from it can
  reach the board. Add it to the rule, or remove it from the preference."* with both one-click fixes
  (`Add to rule`, `Remove from preference`). Clicking `Add to rule` adds the chip to the rule and
  clears the notice. Discard reverts both documents.
  Evidence: `scratchpad/shots/e1-conflict-notice.png`.
- **Preset selection ring matches the mockup exactly** — `rgb(123, 94, 167) 0px 0px 0px 2px` on the
  selected card in both, and it moves to Fast on click (round-2 re-check). (Extraction corrected an
  eyeball read that would otherwise have been filed as a false critical. The *unselected* Fast card's
  attention accent is a separate matter — see B8, where extraction also corrected my own round-1
  evidence.)
- **Operate renders four cards** — `card-daemon`, `card-scheduled-runs`, `card-setup-health`,
  `card-secrets`, in that DOM order — as the parked-slice ruling requires. Re-confirmed in round 2.
  Evidence: `scratchpad/shots/operate-full.png` (round 1),
  `scratchpad/rq-operate-hero.png` (round 2, read).
- **Raw config's S5 error state, live-verified in round 2** (round 1 had it only via e2e): saving
  `{"a": 1,,}` renders *"1 problem to fix / Invalid JSON (line 1): Expected double-quoted property
  name in JSON at position 8 (line 1 column 9)"* — the line number ux-notes §12 asks for is present —
  the `save-bar` stays mounted, Discard restores the original text byte-for-byte, and
  `GET /api/profiles/rajni/config/profile.json` is unchanged against a pre-probe backup.

---

## 4. E2E Coverage Audit

**Round 3: 18 spec files, 117 tests** (round 2: 18 / 114 · round 1: 17 / 110). The three added at
round 3 land in `operate.spec.ts` (the B6 destination test), `settings.spec.ts` (the
`raw-editor-skeleton` test) and `settings-fetching.spec.ts`. Round 2's two unpinned §12 states are
now owned — see §0 (B14). Round-2 text below.

**Round 2: 18 spec files, 114 tests** (round 1: 17 files, 110 tests). New:
`settings-save-model.spec.ts` (4). Settings-overhaul-owned: `settings-landing` (5),
`settings-where-you-work` (4), `settings-fetching` (3), `settings-roles-companies` (3),
`settings-rule-preview` (2), `settings-delivery` (2), `settings-housekeeping` (1),
`settings-save-model` (4), `settings` (10), `operate` (23).

**Disposition Ledger (blueprint.md §e2e): honoured, and the round-1 gap is closed.** All four ids
B10 named now have an owner, each asserting an EFFECT rather than mere existence:

| `data-qa` | Owner | Assertion |
|---|---|---|
| `save-bar` | `settings-save-model.spec.ts:58,80,103,131`, `settings-fetching.spec.ts` | appears on edit, gone after save/discard, visible-and-enabled on a failed submit |
| `save-success-line` | `settings-save-model.spec.ts:71` | appears after save, value round-trips through the server |
| `discard-button` | `settings-save-model.spec.ts:92` | reverts the field, hides the bar, **and does not write to the server** |
| `dirty-nav-dialog` | `settings-save-model.spec.ts:118,147` | both branches — "Save and continue" persists, "Discard changes" does not |
| `validation-summary` | `settings-fetching.spec.ts:115+` | top-of-column placement, both field names, values, and the consequence sentence; save button still enabled |

**Still unpinned at e2e** (`grep -rl` over `ui/e2e/*.spec.ts` returns zero files):

| `data-qa` / `data-testid` | Consequence |
|---|---|
| `scheduled-runs-empty` | The §12 S6/S7 **Empty** state added by the B5 fix — unit-pinned only → **B14** |
| `raw-editor-skeleton` | The §12 S5 **Loading** carrier added by the B9 fix — unit-pinned only → **B14** |
| `danger-zone`, `danger-remove-button` | Ids now exist (B4 closed); behaviour is covered via `data-testid` by `profile-lifecycle.spec.ts:129-171`. Recorded, not filed |
| `geo-connective-line`, `landing-scope-footer`, `scope-chip-profile`, `raw-scope-banner`, `raw-key-badge-*`, `fetch-caps-card`, `pacing-fast-warning`, `pacing-raw-inter-url-{min,max}`, `health-group-not-configured`, `secret-row-telegram-bot-token` | Present and live-verified by me across both rounds; these are elements, not §12 states. Recorded, not filed |
| `settings-search` | R26 Could, non-promotion recorded in blueprint §NOTES — not a defect |

**The round-1 note on why the gates could not catch B1/B2 is now obsolete** — `SaveBar.test.tsx`'s
fabricated-id test was replaced by `ValidationSummary.test.tsx`, and the real ids are asserted
end-to-end. The general lesson stands and is why B14 is filed rather than footnoted: this round's
two new §12 states are again unit-pinned only, which is exactly the coverage shape that let B1 ship
through 3,000+ green tests.

## 5. Bug List

**Round 3 status: 0 open.** All seven round-2 bugs are CLOSED on live evidence — per-bug closing
evidence is in §0's table, the B9(b) ruling in §0.2. The filings below are kept verbatim as the
trail from symptom to fix; each carries a round-3 status stamp. **No bug was downgraded to reach
green, and none was deferred.**

### B11 — CRITICAL — `npm run ui:e2e` fails on every parallel run; the branch cannot land
**Route-to: ui** · *filed round 2* · **CLOSED round 3** — `54a3862` split the suite into a serial
`shared-docs` project and a parallel `default` project; 3/3 green, 117 tests, all 18 spec files
confirmed to run (§0.1).

- **Clause violated:** CLAUDE.md *"Before any PR: `main` is protected — land via a PR with the `test`
  check (`npm run check`) green"* and the CI `ui` job, which runs `ui:e2e`; blueprint.md's §e2e
  Disposition Ledger, which makes the suite a deliverable of this epic.
- **Repro:** `cd /Users/harishamutha/jb-wt-settings && npm run ui:e2e`.
- **Evidence:** three consecutive runs at default parallelism → **3 failed / 2 failed / 1 failed**,
  a different failure set each time (full text in §2). The same suite at one worker is green:
  `npx playwright test --workers=1` → `114 passed`, EXIT 0.
- **Cause class (diagnosed, not fixed):** Playwright runs **4 workers** (8 CPUs; no `workers`, no
  `fullyParallel`, no `test.describe.serial` anywhere). **Eight** spec files read-modify-write the
  same shared `rajni` `profile.json` through the board API and each restores its own captured
  `original` in a `finally`, so one file's restore clobbers another's write. The failures are always
  a config value reading as another spec's number (`Expected: 11 Received: 7`,
  `Expected: 7 Received: 2`, `skipNext` → `undefined`) or a toggle reading unchecked.
- **Why this is critical and not the "known flake" the brief named:** in round 1 this class produced
  one failure that cleared on a single rerun. `5394bdc` added `settings-save-model.spec.ts`, an
  eighth writer contributing **4 more** concurrent `profile.json` write/restore cycles, and
  the suite now has **no clean run at default parallelism**. It is a test-isolation defect, not an
  app defect — the app is green at one worker — but a gate that never passes is a gate that blocks
  the PR, and nothing downstream of it is verifiable on the strength of a green run that does not
  exist.
- **Note for the fixer:** QA proposes no fix. The evidence needed to choose one is in
  `scratchpad/D3-static-evidence.txt` and `rq-e2e-serial.log`.

### B9 — MAJOR — S4 and S5 loading states still miss ux-notes §12
**Route-to: ui** · *filed round 1* · **CLOSED round 3** — S4 now renders a 12-element field-shaped
skeleton; S5's `min-h-[70vh]` skeleton is adjudicated as meeting §12's intent (0px movement of
every visible landmark) — see §0.2 for the full ruling and the numbers behind it.

- **Clause violated:** ux-notes §12 — S2/S4 *"field-shaped skeletons"*; S5 *"textarea skeleton at
  same height (**no layout shift**)"*.
- **Fixed half (verified):** S2 `where-you-work` renders **13** `[data-slot="skeleton"]` elements and
  no "Loading…" string; S3 `fetching` renders **18**. Both resolve with no shift.
- **Still open, S4 `roles-companies`:** **0** skeletons, **0** `animate-pulse` elements; the content
  column renders the bare string `"Loading…"`. Screenshot
  `scratchpad/rq-shot-rolescompanies-loading.png`. `loadingFallback` was passed to only two of the
  ten `DocFormGate`-wrapped sections (`grep -rln loadingFallback ui/src/features/settings` →
  `FetchingSection.tsx`, `WhereYouWorkSection.tsx`).
- **Still open, S5 `raw-config`:** the skeleton now exists but is the wrong size.
  `[data-testid="raw-editor-skeleton"]` renders **320px** tall (`h-80`); the resolved
  `[data-qa="raw-editor"]` textarea renders **2186px** (`field-sizing: content`, `rows=14`,
  2057-char document). The scrolling `<main>`'s `scrollHeight` goes **808 → 2402** on resolve — a
  **+1594px** layout shift, against a clause whose parenthetical is literally "no layout shift".
  (Round 1 measured +1674px on this screen by a different metric; the shift is essentially unchanged.)
- **Honest note for the fixer:** with `field-sizing: content` the resolved height depends on document
  length, so an exactly-matching fixed skeleton is not achievable. Sizing the skeleton to the
  available column height rather than `h-80` would satisfy the clause's intent; that is a design call
  the fixer should make explicitly rather than inherit from `h-80`.
- **Untested:** the remaining seven `DocFormGate` sections (`skills`, `delivery`, `housekeeping`,
  `where-jobs-come-from`, `schedule`, `about-you`, `filters`) also render the bare "Loading…" per the
  same grep, but §12 names no row for them — recorded in NOTES, not filed.

### B6 — MINOR — the missing-secret health row's destination control does nothing
**Route-to: ui** · *filed round 1* · **CLOSED round 3** — the control is labelled "Secrets", moves
focus into `card-secrets`, and at 1440×600 scrolls the genuinely-below-fold card into view (§0).

- **Clause violated:** spec R22 / AC20 — *"each linking to **the exact place to fix it**"*.
- **What changed:** `checkDestination.ts` now routes `env-tokens` / `telegram-bot-token` to
  `{name:'setup'}` and the cell reads **"Operate"** instead of "Settings". The round-1 symptom (a
  link to a page with no token field) is gone.
- **What is still wrong:** `card-setup-health` only ever renders **on** Operate, so the control now
  points at the page the user is already on and is inert 100% of the time.
- **Evidence:** row `health-row-env-tokens`, destination is a `<button>` with `destHref: null`;
  clicking it leaves `location.hash` at `#/setup`; the accessibility-snapshot diff before/after the
  click has exactly one delta — the button gains `[active]` (focus). No navigation, no scroll, no
  DOM change. The fix it means to point at, `card-secrets`, sits lower on the same screen
  (`rect y=658`, and below the fold once the "7 OK checks" disclosure is expanded — see
  `scratchpad/rq-operate-hero.png`).
- **Why still minor:** the secrets card is on the same screen and reachable by scrolling, so the user
  is not blocked — but the row promises a jump it does not perform, which is exactly the inert-label
  failure the interaction sweep exists to catch.

### B8 — MINOR — the Fast preset's `--attention` accents are now missing entirely
**Route-to: ui** · *filed round 1* · **CLOSED round 3** — all four edges match the mockup exactly and
the warning tint composites pixel-identically (§0).

- **Clause violated:** mockup S3 — `mockup.html:449` gives the Fast card
  `class="preset-card attention"` while `aria-checked="false"`, and the mockup's own stylesheet says:
  - `mockup.html:150` — `.preset-card.attention{border-left:2px solid var(--attention)}`
  - `mockup.html:153` — `.preset-warning{…background:var(--attention-10);border-left:2px solid var(--attention);border-radius:16px;padding:8px}`
- **Evidence (computed, unselected Fast card, 1440×900):**

  | property | APP | MOCKUP |
  |---|---|---|
  | `borderLeftColor` | `rgb(228, 219, 240)` | **`rgb(255, 138, 61)`** |
  | `borderLeftWidth` | `1px` | **`2px`** |
  | `borderTop/Right/BottomColor` | `rgb(228, 219, 240)` | `rgb(228, 219, 240)` |
  | `pacing-fast-warning` background | none (plain `Alert`) | `--attention-10` + 2px `--attention` left border |

  Images: `scratchpad/rq-shot-presets-app.png` vs `scratchpad/rq-shot-presets-mock.png` — the
  mockup's orange left accent is visible on both the card and its warning box; the app has neither.
- **This report owes the fixer an apology.** Round-1 B8 cited `borderTopColor` alone. That evidence
  was true (the app was painting `--attention` on all four edges, which the mockup does not) but it
  under-specified the target, and the fix reasonably read it as "remove the attention border". The
  correct target is: **left edge 2px `--attention`, other three edges 1px `--border`**, plus the
  warning box's `--attention-10` tint and 2px left border. The selection ring is correct in both and
  must not change (`rgb(123,94,167) 0 0 0 2px` on the checked card, verified moving to Fast on click).

### B12 — MINOR — `ValidationSummary` drifts from mockup S8 in styling and per-field copy
**Route-to: ui** · *filed round 2* · **CLOSED round 3** — container matches on every measured
property; the max field carries its own sentence and a short inline error (§0).

- **Clause violated:** mockup S8 (`mockup.html:175-177` and `:736-742`); ux-notes §11.
- **Evidence (computed, APP | MOCKUP):**

  | property | APP | MOCKUP |
  |---|---|---|
  | `backgroundColor` | `rgb(255,255,255)` | `rgba(214,69,69,0.08)` |
  | `borderWidth` / left colour | `1px` all round, `rgb(228,219,240)` | `0 0 0 2px`, left `rgb(214,69,69)` |
  | `padding` | `8px 10px` | `16px` |
  | `gap` | `2px` | `8px` |
  | title colour / weight | `rgb(214,69,69)` / 500 | `rgb(61,44,85)` / 700 |
  | link colour / size / weight | `rgb(214,69,69)` / 14px / 400 | same — this one matches |

- **Copy half:** both summary items **and** both inline field errors carry the identical
  min-phrased sentence. The mockup gives the max field its own sentence —
  *"Maximum jitter (12000 ms) is below minimum jitter (15000 ms). The run would fail to start."* —
  and a **short** inline field error, *"Above maximum jitter (12000 ms)."* The knock-on is that one
  cross-field violation is announced as *"2 problems to fix"* with the same sentence twice
  (`scratchpad/rq-shot-failed-save.png`).
- **Scope note:** this is newly *measured*, not newly *introduced* — round 1 verified the summary's
  placement, focus and copy but not its computed styling against the mockup. It is in scope because
  S8 is a mockup state in the §12 inventory and the brief named it for regression spot-check.

### B13 — MINOR — `--destructive` as body text still fails 4.5:1, and now ships in the error summary
**Route-to: ux** · *filed round 2* · **CLOSED round 3** — the advisor ruled `--destructive-strong`
the destructive-TEXT token and amended ux-notes §14; QA verified the ratios only (5.53:1 on white
for summary links, inline `FieldError` and `daemon-state`) and did not re-litigate the choice.

- **Clause violated:** ux-notes §14 — *"`--destructive #d64545` is used as text only at `text-xs`+
  weight 500 **against `#ffffff`**"* and *"Contrast … clears 4.5:1 for body text"*.
- **Evidence:** `validation-summary`'s title (`rgb(214,69,69)`, 14px, weight 500) and its links
  (same colour, 14px, weight 400) render on a composited `rgb(255,255,255)` → **4.38:1**, below
  4.5:1. For reference the mockup's own summary links compute **3.74:1** on its tint.
- **Why this routes to ux, not to the implementer:** B7's fix introduced `--destructive-strong`
  (`#c62c2c`, **5.53:1** on white) but scoped it to `daemon-state` only, and B7's own caveat recorded
  that the pairing ux-notes sanctions (`#d64545` on `#ffffff`) is itself 4.38:1 — the *rule* is
  internally non-conformant. That ruling was never made, so the failing pairing has now shipped in
  the epic's highest-stakes error surface. The design call — adopt `--destructive-strong` as the
  destructive **text** token and correct ux-notes §14, or accept 4.38:1 explicitly — belongs to ux,
  not to a unilateral implementer change.
- "Never colour alone" is satisfied throughout: every message is a sentence, not a colour.

### B14 — MINOR — the two §12 states added this round have no e2e owner
**Route-to: ui** · *filed round 2* · **CLOSED round 3** — `scheduled-runs-empty` →
`operate.spec.ts:408-410`; `raw-editor-skeleton` → `settings.spec.ts:242-249`, which asserts
visibility **and** `height > 400` so the skeleton cannot silently shrink back.

- **Clause violated:** blueprint.md §e2e Disposition Ledger (every §12 state carries an explicit e2e
  owner); ux-notes §12 rows S6/S7 **Empty** and S5 **Loading**.
- **Evidence:** `grep -rl` over `ui/e2e/*.spec.ts` returns **zero files** for both
  `scheduled-runs-empty` (the B5 fix) and `raw-editor-skeleton` (the B9 fix). Both are unit-pinned
  only (`ScheduledRunsCard.test.tsx`, `RawConfigSection.test.tsx`).
- **Why filed rather than footnoted:** this is precisely the coverage shape B10 was filed for. B1 — a
  regression that removed the primary action from the highest-stakes Must — shipped through
  2114 + 1001 + 110 green tests because its state was unit-pinned only. Two new §12 states have just
  landed in the same shape.

<details><summary><b>Closed in round 2</b> — B1, B2, B3, B4, B5, B7, B10, with closing evidence</summary>

**B1 — save-time validation feedback below the fold, save control unmounted — FIXED.**
Repro re-run at 1440×900. `validation-summary` rect `{x:496, y:128, w:896, h:80}`, `position:
relative`, fully inside the 900px viewport, and it *is* the first child of the content column
(`[data-testid="settings-section"]` rect `y=128`, `firstChildY=128`). Across the failed submit the
counts hold at `save-bar=1, save-button=1, discard-button=1` (round 1: `1 → 0`), and
`document.activeElement` is the summary itself (round 1: `BODY`). Screenshot
`scratchpad/rq-shot-failed-save.png` shows summary and sticky bar together in one viewport.
`SaveBar.tsx`'s four-state exclusivity is gone; `ValidationSummary.tsx` is rendered by all eight
sections that previously passed `errors` to `SaveBar` (grep-verified — no section lost its summary).

**B2 — summary links never moved focus — FIXED.** Input ids are now the error keys:
`["fetching.maxNewPerLane","fetching.maxProbesPerRun","fetching.maxCardsPerUrl","fetching.maxAgeDays","","fetching.jitterMinMs","fetching.jitterMaxMs","fetching.interUrlDelayMinMs","fetching.interUrlDelayMaxMs"]`.
`document.getElementById('fetching.jitterMinMs')` → non-null. After clicking the first summary link,
`document.activeElement` = `INPUT#fetching.jitterMinMs` (round 1: the `<a>` itself). `aria-invalid`
count stays 2.

**B3 — cross-field copy dropped the consequence — FIXED.** Live text:
*"Minimum jitter (99999 ms) is above maximum jitter (12000 ms). The run would fail to start."* —
both fields, both values, the consequence. Singular/plural is correct: the raw-config parse error
renders *"1 problem to fix"*. (The max-field's wording is a separate, smaller drift → B12.)

**B4 — danger-zone render-contract ids — FIXED.** `[data-qa="danger-zone"]` = 1 on load;
after clicking `danger-open`, `[data-qa="danger-confirm-input"]` = 1 and
`[data-qa="danger-remove-button"]` = 1.

**B5 — Scheduled runs card had no empty state — FIXED.** `GET /api/daemon` → `"profiles": []`;
`[data-qa="scheduled-runs-empty"]` = 1 reading *"No scheduled runs — enable a schedule in
Settings → Schedule."*; `[data-qa^="schedule-row-"]` = 0; the row-describing footer
("Active profile row highlighted…") is **absent** from the card's textContent. Screenshot
`scratchpad/rq-operate-hero.png`. Not yet pinned at e2e → B14.

**B7 — daemon status word failed 4.5:1 — FIXED (render half).** `daemon-state` now computes
`rgb(198,44,44)` (`--destructive-strong #c62c2c`) at 14px / weight 500. Contrast **5.24:1** against
the composited background, **5.53:1** against white. *Measurement note, stated because it changes
nothing but should not be hidden:* the extraction script could not parse the card's
`oklab(0.596556 0.165398 0.0754223 / 0.1)` tint layer and composited against `#faf8fd` instead. Hand-
computing the tint properly (`#d64545` at 10% over `#faf8fd` → `rgb(246,230,235)`) gives **4.60:1** —
still above 4.5:1, so the verdict holds on either background. The ux half B7 flagged is open as B13.

**B10 — the shared save model had no e2e coverage — FIXED.** `ui/e2e/settings-save-model.spec.ts`
adds 4 tests, each asserting an effect rather than existence: the dirty bar appears and the value
round-trips through the server; Discard reverts **and does not write**; and both dirty-nav-dialog
branches ("Save and continue" persists, "Discard changes" does not). `settings-fetching.spec.ts` was
extended to assert the summary's top-of-column placement, the full consequence sentence, and that
the save button stays enabled. All four previously-orphaned ids now have owners (§4). **This fix is
also the proximate cause of B11** — the new spec adds 4 more concurrent writers to the shared
fixture.

</details>

## 6. Deferred

**None.** No bug in this report has been deferred. Only the USER may defer one, relayed through the
orchestrator; no deferral was requested or granted, and none was assumed.

---

## 7. Residual Risk

Testing shows the presence of defects, never their absence. **Green here means "no known bugs", not
"no bugs"** — and a defect-free matrix still would not prove the feature serves the user. What was
**not** verified, and why:

1. **R19 and R20's live effects (AC17, AC18) remain deliberately unexercised — still the single
   largest untested surface, and the riskiest thing this report does not know.** Starting the daemon
   from the board spawns a real detached process against the worktree home that would claim run
   intents and could drive a real Chrome run; `Autostart` writes a real darwin LaunchAgent outside
   the worktree. `Start`, `Pause all` and `Autostart` were not clicked in any of the three rounds.
   All three are covered by stubbed e2e (`operate.spec.ts:123,192,211,251`) — and unlike round 2,
   that stubbed coverage is now reliably green.
2. **The spec's named riskiest assumption is still only partly retired.** ux-notes weakness 3 flagged
   that R2's conflict notice rests on an unverified `filter.json.timezones` semantic. The notice
   fires, reads correctly and both one-click fixes work — but only against the `rajni` fixture's
   shape, and nothing here proves the *pipeline* actually drops the job the notice claims it drops.
   A notice that disagrees with the filter stage would be worse than none. **This remains the
   headline unverified assumption of the epic.**
3. **The e2e suite's isolation is now correct-by-construction for config docs, but two other shared
   writers were left in the parallel project.** `env-guard.spec.ts` writes the repo-root `.env` via
   `/api/secrets/NOTION_TOKEN`, and `runcontrol.spec.ts` creates and deletes `rajni` `run_intents` —
   neither is in `SHARED_DOC_SPECS`, so both run at 4 workers alongside every other `default` spec.
   Three green runs say this does not currently race, and neither writes a **config doc** (the class
   B11 was actually about), so it is recorded here rather than filed. It is the most likely source
   of a future flake.
4. **Only one viewport-pair and one browser.** Everything was measured at 1440×900 (Chromium), with
   a single deliberate 1440×600 probe for B6. Narrow/mobile widths remain untested. B9(b)'s
   `min-h-[70vh]` skeleton is viewport-proportional and was verified only at 900px tall.
5. **S9 Danger-zone Error is the one `untested` cell in the §12 matrix.** The 409
   `run_in_progress` / `intent_pending` branch is implemented (`DangerZone.tsx:47,76-77`) and no test
   drives it; QA did not drive it either, because provoking it means starting a real run. The
   happy path and the wrong-name friction gate are both verified.
6. **Leaf-text sizing across the settings surface was measured but not adjudicated.** An exhaustive
   paired sweep (65 shared `data-qa` ids, `scratchpad/r3/paired-sweep-out.txt`) shows the app
   rendering several secondary strings at `text-sm`/14px where the mockup uses 12px
   (`pacing-fast-warning`, inline `FieldError`, `landing-cap-row-*`, `secret-row-*`). This is **not
   filed** — see NOTES for the reasoning — but it is unadjudicated, and if the user wants pixel
   fidelity to the mockup at leaf level, that is a real (small) body of work nobody has costed.
7. **Browser reload silently discards a dirty draft** (confirmed in round 2, unchanged). R5 is scoped
   to *"switching section or profile"*, so this violates no clause and is not filed — but it is real,
   and it is the one silent-discard path the guard does not cover.
8. **AC24's second half is still structural, not live.** The `127.0.0.1`-only bind was probe-verified
   in round 1; *"no board route spawns a run by any path"* rests on the green `boundaries` gate and
   on code structure, not on a live attempt to make a route spawn one.
9. **`rulings/ui-impl-gate-r1.md` findings 4 and 5 remain accepted residuals**, unchanged — most
   visibly, uncommitted chip/time input text sits outside `isDirty`, so typing into an empty chip
   entry does not raise the save bar.
10. **Round-2 residual-risk items 3 and 9 are retired.** Item 3 (every e2e-backed row discounted
   because the suite had no clean run) no longer applies — the suite is green at its own default
   invocation. Item 9 (the stale dirty-nav destination that did not reproduce) stayed closed; the
   round-3 exploratory pass varied the walk rather than replaying it and saw nothing like it.

---

## 8. Verdict

**GREEN — 0 open bugs (0 critical / 0 major / 0 minor).** All four gates pass; `npm run ui:e2e` is
green on three consecutive runs at its default invocation. **No PR was opened** — the round-3 brief
explicitly withheld it, so opening one is the orchestrator's next call, not a step QA skipped.

Nothing was deferred (§6 stands: only the USER may defer, relayed through the orchestrator, and no
deferral was requested or granted) and **no severity was downgraded to reach this bar**. All seven
round-2 bugs closed on live evidence, including the one that mattered most operationally — B11, the
gate that had no clean run — and the one that took real judgment, B9(b), where the honest answer was
that the clause's literal words are unachievable but its intent is fully met, and the measurement
that settles it is 0px of movement on every visible landmark.

Three rounds, in shape: round 1 found 10 bugs, of which the important one (B1) was a save control
that unmounted itself under 3,000+ green tests; round 2 closed 7 and found 4 more, one of which was
a red CI gate that the *previous round's own fix* had tipped over; round 3 closed all 7 and found
none. The pattern worth keeping is that every bug in rounds 1 and 2 that mattered was invisible to
the test suite and visible to a script that read computed styles and diffed a DOM snapshot before
and after a click. The e2e ledger is now complete against the §12 inventory, which is what should
stop the next B1 from shipping.

What green does **not** cover is in §7, and two items there deserve to be read before this merges:
the daemon's live start/pause/autostart effects have never been exercised in any round, and the
conflict notice — the epic's headline payoff — has never been checked against the filter stage it
makes a promise about.

---

## NOTES

Judgment calls and findings that did not qualify as bugs.

- **Leaf-text sizing (14px vs the mockup's 12px) is not filed as drift, deliberately.** An
  exhaustive paired sweep produced 129 property diffs across 65 shared ids, but the great majority
  are adjudicated **in the app's favour by ux-notes §3**, which is the stated authority ("every value
  in the mockup comes from this table"): card `borderRadius` 22.4px vs the mockup's 16px is §3's
  `--radius-xl` for cards, *"verified: `card.tsx:15` uses `rounded-xl`"*; card `borderLeftWidth` 0px
  vs 1px is §3's sanctioned `ring-1` card edge; card-title weight 500 vs the mockup's 600 is §3's
  own `font-medium`. Of what remains, the 14px-vs-12px strings sit inside primitives the
  **blueprint** explicitly assigned — `blueprint.md:187` maps `pacing-fast-warning` to the vendored
  `Alert` with `bg-attention/10`, `:257` maps `validation-summary` to the same `Alert`, and
  `:108` reuses the existing `Form`/`FieldError` as-is — with no size override specified. The app
  implements the blueprint faithfully; the size follows from the primitive the blueprint chose. That
  makes this a blueprint-level question, already passed by `rulings/ui-impl-gate-r1.md`, not an
  implementation defect — and filing it at round 3 would be QA expanding scope rather than verifying
  it. Recorded in §7.6 so the choice is visible rather than silent. Evidence:
  `scratchpad/r3/paired-sweep-out.txt`.
- **"Run now" is not inert.** The interaction sweep initially showed no accessibility-snapshot delta
  within 500ms of clicking it, which is the exact shape of the inert-label failure the sweep exists
  to catch. Investigated: the click **did** work — it inserted run intent `127` into the `rajni`
  DB — and the control then relabels itself from `runState.ts:143`, which is why a subsequent
  `getByRole('button', {name:/run now/i})` lookup found nothing. QA cancelled the intent
  (`DELETE /api/profiles/rajni/run-intents/127` → `status: "cancelled"`). The control is also
  pre-existing `ui/src/features/runcontrol/`, outside this epic's surface, and is covered by
  `runcontrol.spec.ts`. Not a defect.
- **The `Operate` sidebar item producing no delta is correct**, not inert — it is the nav item for
  the page already open.
- **One screenshot is not usable evidence and is not cited as such.** `r3-failed-save-mock.png`
  captured the mockup's S2 region rather than S8 (the `scrollIntoView` did not settle before the
  shot). It changes nothing: the mockup side of the B8/B12 comparison was extracted **numerically**,
  which is the evidence those verdicts rest on. Flagged rather than quietly dropped.
- **Method note.** The live drive was performed with the repo's own Playwright driver via scripts
  rather than the Playwright MCP tools, matching rounds 1–2 — computed-style extraction and
  before/after DOM-snapshot diffing need in-page evaluation. The MCP tools were confirmed to resolve
  (a navigate against the running board returned a snapshot) and the `.playwright-mcp` artefact that
  produced in `/Users/harishamutha/Job-bunny` was deleted along with its directory.
- **The tint "diffs" reported by the raw extractor were serialization artefacts, not drift.** Tailwind
  emits `oklab(...)` for `bg-destructive/8` and `bg-attention/10` where the mockup writes `rgba(...)`.
  Rendered over white both pairs composite to identical pixels — `rgb(252,240,240)` for the summary
  tint and `rgb(255,243,235)` for the warning tint — so B8's and B12's background halves are exact.
