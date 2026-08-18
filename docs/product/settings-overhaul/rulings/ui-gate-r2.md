MODE: DESIGN-REVIEW (re-gate; prior ruling `rulings/ui-gate-r1.md` supplied and binding)
STATUS: done
VERDICT: **CLEARS WITH CONDITIONS**

---

# FILED RULING — settings-overhaul UI-blueprint gate, round 2 (condition discharge)

**TARGET:** `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/blueprint.md` (1338 lines, amended in place 2026-08-18)
**PRECEDENT:** `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/rulings/ui-gate-r1.md` (BLOCKED, 6 conditions)

**All six conditions are DISCHARGED.** The amendment adds what was missing without reworking what round 1 cleared — spot-checks confirm no regression. Four small new findings (two one-line done-condition gaps, three citation/reuse cosmetics) are routed but do not gate: none of them touches Group A, and both load-bearing ones are single clauses inside steps that land late (9d, 35).

---

## PER-CONDITION DISCHARGE

### Condition 1 (F1 + F5) — Landing steps — **DISCHARGED**
- Steps **9a–9d** exist at `blueprint.md:556-629`, internally dependency-ordered (9a model → 9b/9c tables → 9d composition), placed after step 9 and before step 10.
- Mounted: `SectionBody`'s `'landing'` case is explicit at `blueprint.md:861-867` ("mounts `LandingSection` (step 9d), **not nothing**"), with a parametrized `SettingsPage.test.tsx` case per slug. `SettingsNav` carries the landing link at `blueprint.md:872-878`; its corrected claim that the mockup's Aim group holds 5 links incl. "What decides your board" is **true** — `mockup.html:264-273` shows exactly that, `active`/`aria-current="page"`.
- e2e in-step: `ui/e2e/settings-landing.spec.ts` with three cases (`blueprint.md:617-629`), including (c) which asserts bare `#/settings` renders `landing-caps-table` — a mechanical closure of F1's defect, not a routing-table claim.
- **Reuse (F5) verified against the real file, not the claim.** `/Users/harishamutha/Job-bunny/ui/src/features/runs/runResult.ts` exports `getFunnelStages` (`:36`, returns `FunnelStage[] | null`), `getBiggestDrop` (`:76`, takes `FunnelStage[]`, returns `{stage,rule,count} | null`), `newMatchCount` (`:59`, takes `unknown`), `computeRetention` (`:97`). Every signature step 9a asserts is real: `scraped` from the first stage's `jobsIn` (`FunnelStage.jobsIn`, `:11`), `biggestDrop = getBiggestDrop(stages ?? [])` type-checks, and the "null-on-malformed contract" it relies on is the file's actual behaviour (`:39`). The header quote at `blueprint.md:551-553` matches `runResult.ts:1-8` faithfully.
- **No duplicate types module anywhere in the amended text**: `grep "runResult.types\|sections/landing/"` returns only the F5 disposition line recording the withdrawal (`blueprint.md:1250`). Filepaths are flat `sections/*` in both §1 (`:146-153`) and steps 9a-9d — consistent.

### Condition 2 (F2) — e2e Disposition Ledger — **DISCHARGED**
- Ledger at `blueprint.md:393-438`. **I re-counted both files myself**: `ui/e2e/settings.spec.ts` = **12** tests (lines 52, 77, 100, 120, 141, 171, 208, 224, 252, 280, 302, 332); `ui/e2e/hub.spec.ts` = **6** (lines 69, 80, 89, 103, 142, 172). Every ledger row's cited line number matches the real test line, 18 for 18, with a per-test SURVIVE/ADAPT/REPLACE and a named destination step.
- The four daemon-state e2e have **concrete destinations**: `blueprint.md:414-417` → step 30 done-conditions (g)(h)(i)(j), authored at `blueprint.md:957-973`, each naming its source fixture. Spot-verified: 30(g)'s `degraded: true, schemaVersion 8, buildVersion 7` mirrors the real fixture at `settings.spec.ts:252-262`; 30(i) reuses `stubDaemonUnreachable`, which genuinely exists (`ui/e2e/run-fixtures.ts:284`), as do `stubDaemonStatus` (`:309`), `stubRunsList` (`:178`), `stubSoftErrors` (`:205`).
- **`api-unreachable` has a named owner with a real step reference**: `DaemonCard.tsx` at step 30(i) (`blueprint.md:964-969`), and step 16's "caller's concern" is rewritten to name both callers (`blueprint.md:733-742`). Step 30 exists at `:915`.
- Step 37's blanket clause is retired and replaced by per-test accounting (`blueprint.md:1075-1082`).

### Condition 3 (F3, user ruling) — wizard entry — **DISCHARGED**
- `blueprint.md:1047-1053`: a footer button on `SetupHealthCard`, `onClick={() => navigate({name:'onboarding'})}`, mirroring `HubPage.tsx:122-128`, existing route untouched.
- **Effect-asserting done-condition present** (`blueprint.md:1060-1065`): clicks the button, asserts navigation to `#/onboarding` **and** `getByTestId('wizard')` visible. That is substantively the shipped test — `ui/e2e/hub.spec.ts:172-177` asserts `toHaveURL(/#\/onboarding/)` + `getByTestId('wizard')`. Route `'onboarding'` confirmed live at `ui/src/lib/router.ts:9`.

### Condition 4 (F4) — effect done-conditions — **DISCHARGED** (all five, each would fail on an inert control)
| Control | Where | Why it can't pass inert |
|---|---|---|
| `daemon-autostart` | `blueprint.md:945-951` | asserts `setAutostart(true)` **fires**, then renders `{outcome:'ok'}` checked and `{outcome:'unsupported_platform'}` as the static row — **both** `AutostartOutcome` values, matching blueprint-be's pinned `{outcome:'ok'\|'unsupported_platform'}` (`blueprint-be.md:285, 909`) |
| `daemon-pause-all` | `blueprint.md:952-956` | spy on the hook's `mutate` (invocation asserted) **plus** the rendered count/failed-profile line |
| `linkedin-session-check` | `blueprint.md:1020-1028` | route/spy assertion that the POST fires, plus the pre-resolution no-optimistic-flip state |
| `discard-button` | `blueprint.md:488-494` | asserts the draft reverts via the hook's `discard()`, explicitly rejecting a presence-only check |
| `raw-key-badge-*` | `blueprint.md:838-842` | `navigate({name:'settings',section:'schedule'})` spy, plus the raw-only badge's absence of a click target |

### Condition 5 (F6) — step 9 identifiers — **DISCHARGED**
- `blueprint.md:513-537` withdraws the false "extend the existing re-export line" claim (states both counts correctly: 4 blocks, none daemon; daemon barrel exports zero types) and names the hard BE dependency.
- Its three-block code snippet (`blueprint.md:524-526`) matches blueprint-be's pins **exactly**, cross-read first-hand: `BreakerStatus` (`blueprint-be.md:280`, §11a `:1256`), `LinkedinSessionStatus` (`:281`, `:1257`) → `app/features/linkedin/index.ts`; `FilterPreviewResult` (`:276`, `:1258`) → `app/features/preview/index.ts`; `StopDaemonOutcome`/`StartDaemonOutcome` (`:284`, `:1259-1260`), `AutostartOutcome` (`:285`, `:1261`) → `app/features/daemon/index.ts`. All homed in `src/ports/board.ts`; step 9 correctly never reaches past a feature barrel.

### Condition 6 (F7) — empty states + §8 — **DISCHARGED (with residual, see R2-F2)**
- S2: `blueprint.md:648-654` + e2e case 4 at `:673-675`. S4: `blueprint.md:696-700, 703-705`. Copy is **verbatim** from `ux-notes.md:478,490` — *"No rules — nothing is dropped for this reason"* + inline `[Add]`, which I read first-hand.
- S5: `blueprint.md:832-838` + an e2e proving create-on-first-write at `:851-853`. Copy matches `ux-notes.md:480` — *"Not created yet — saving will create it"*.
- §8's loading claim is now qualified per-mechanism (`blueprint.md:1226-1233`) and backed by a real done-condition at step 30(j). Its citation of step 9d as backing is the residual — see R2-F2.

### Condition 7 — amendment hygiene — **DISCHARGED**
- Both self-caught fixes hold: no `sections/landing/` path survives anywhere; step 18 now cites **step 30** and names step 20 as `PacingPresetCard` (`blueprint.md:766-768`).
- Dispositions section exists (`blueprint.md:1237-1264`), one row per F1–F10.
- **No regression on previously-cleared material** (spot-checked 3 + 2): step 19(c)'s negative assertion "the doc was **not** written" intact (`:786`); step 30(d)'s `child_unresponsive` pid assertion intact (`:939-941`); step 36's `page.content()` secret scan intact (`:1071-1074`); step 21's "no interactive role" (`:815-818`) and step 34(b)'s zero-reset-button assertion (`:1017-1020`) intact. The 89-id subtotals still sum to 89 (`:272-281`). The F10 correction is **exactly right** — I re-grepped `ScheduleSection.tsx`: `-strong` sites are 176, 178, 181, 206, 207, 218.

---

## NEW FINDINGS (introduced or surfaced this round)

**R2-F1 — load-bearing — step 35's done-conditions under-deliver two assertions the ledger and §5 promise.**
The ledger row for `hub.spec.ts` test 3 (`blueprint.md:435`) promises "a stubbed `warn` finding appears under **Needs action** with its destination", and §5 R22 (`:1120`) lists a "needs-action grouping test". Step 35's actual done-conditions (`blueprint.md:1053-1060`) assert only (i) all-ok → collapsed line, (ii) one `warn` with a **cli-command** destination → `[Copy: <cmd>]` + clipboard. Neither group membership (`health-group-needs-action`) nor the **settings-link** destination half — which step 28 (`:901-902`) claims step 35 covers for hub test 5's "Edit in Settings" — is asserted anywhere. Same shape as round 1's F4: a claimed coverage with no done-condition behind it. **Route: product-ui — two clauses in step 35.**

**R2-F2 — load-bearing — Landing's loading and error states are prose-only, and 9d(b) closes a case it doesn't test.**
`blueprint.md:611-614` specifies a card skeleton (loading) and a block-scoped `ErrorRetry` (error) for `LandingSection`, matching `ux-notes.md:477`'s S1 row. 9d's done-conditions (a)(b)(c) cover default, empty and default-route mount only — no loading, no error. Worse, `:623-625` asserts case (b) "closes §12:477's *caps can fail while rules load* case", but (b) stubs `GET .../runs` → `[]`, which is **empty, not failing**; the failure-independence the §12 row actually specifies goes unasserted. The F7 disposition (`:1252`) cites step 9d as backing §8's loading claim — it does not. **Route: product-ui — two e2e cases in 9d (hold the runs query open; fail the runs GET and assert caps/rules still render).**

**R2-F3 — cosmetic — internal step mis-citation, same class as the one self-caught.**
`blueprint.md:774` cites "the pacing card (`PacingPresetCard.tsx`, **step 21**)"; `PacingPresetCard` is **step 20** (`:787`) — step 21 is `DeliverySection`. Every other of the ~90 internal `step N` references I swept resolves correctly. **Route: product-ui, one word.**

**R2-F4 — cosmetic — `runResult.ts` line count is wrong in three places; my own precedent is overruled on this fact.**
`blueprint.md:94, 548, 1328` state "183 lines", each attached to a "full read" claim. Actual: **109 lines** (`wc -l /Users/harishamutha/Job-bunny/ui/src/features/runs/runResult.ts`; its test is 284). **Stare decisis correction: `ui-gate-r1.md:77` and `:157` asserted 183 too — that figure was wrong in my prior ruling and is overruled here, not distinguished.** The blueprint inherited it. Every substantive claim about the file (exports, signatures, header posture) verified correct, so this changes no decision. **Route: product-ui, number fix.**

**R2-F5 — cosmetic — `ErrorRetry` is not a shared component; Landing would be its third copy.**
`blueprint.md:612` says "an inline `ErrorRetry` scoped to this one block" as if reusing something. It is a **local function defined twice**: `ui/src/features/triage/TriagePage.tsx:37` and `ui/src/features/runs/RunsPage.tsx:79`, neither exported. By the blueprint's own ChipInput rationale (`:289-297` — "a third and fourth copy would violate reuse-first in spirit"), this warrants either consolidation or an explicit note that a third local copy is deliberate. **Route: product-ui, one sentence.**

**R2-F6 — unverified assumption, BE-side, outside this target — `FilterPreviewResult`'s "already there" wording.**
`blueprint-be.md:1258` (§11a) lists its home as "`ports/board.ts` (already there, unchanged)"; `blueprint-be.md:699-701` says it "is already named and already lives in `ports/board.ts` **as of this step**". It does **not** exist in the repo today — `grep FilterPreviewResult /Users/harishamutha/Job-bunny/src/ports/board.ts` → zero hits (292 lines). BE step 31 (`:690-696`) does author it, so the plan is sound and **UI step 9 is unaffected** (it imports from the `preview` barrel, never `ports/board.ts`); only §11a's table wording misleads a reader into thinking no BE work is owed. **Route: product-be, wording only — does not reopen the BE gate.**

---

## CONDITIONS ON THIS CLEARANCE

1. Fold **R2-F1** and **R2-F2** into `blueprint.md` before steps 9d and 35 are implemented (four clauses total). Neither blocks Group A/B start.
2. R2-F3, R2-F4, R2-F5 are one-line hygiene fixes to be swept in the same pass; R2-F6 routes to product-be as wording.
3. **No re-gate required.** These are verifiable against this ruling by the implementer or the change-review at PR time.

---

**EVIDENCE**
- 12 `settings.spec.ts` tests / 6 `hub.spec.ts` tests — own `grep -n "test("` on both files — **confirmed exactly**, and all 18 ledger line-citations match.
- Landing steps exist, ordered, mounted — own read of `blueprint.md:556-629, 861-867, 872-878` — **present**; nav-link claim cross-checked against `mockup.html:264-273` — **true**.
- `runResult.ts` reuse claims (`getBiggestDrop`/`newMatchCount`/`getFunnelStages` signatures, null-on-malformed) — own full read of the file — **all real**; line count **wrong (109 ≠ 183)**.
- Six BE identifiers + `AutostartOutcome`'s two values — own read of `blueprint-be.md:276, 280-281, 284-285, 909, 1256-1261` vs `blueprint.md:524-526` — **exact match**.
- §12 empty-state copy verbatim — own read of `ux-notes.md:477-480, 490` — **matches blueprint's quoted strings**.
- §17 `health-group-*` template — own read of `ux-notes.md:627` — **all three ids now rendered per `blueprint.md:1042-1047`** (F8 closed).
- e2e fixtures the amendment claims to reuse — own `grep -n "^export" ui/e2e/run-fixtures.ts` — `stubDaemonUnreachable:284`, `stubDaemonStatus:309`, `stubRunsList:178`, `stubSoftErrors:205` — **all exist**.
- Wizard-entry e2e substance — own read of `ui/e2e/hub.spec.ts:172-177` — **step 35's done-condition mirrors it**.
- `#/onboarding` route live — own read of `ui/src/lib/router.ts:3-11` — **present**.
- F10 correction — own `grep -- "-strong" ScheduleSection.tsx` — **176,178,181,206,207,218, exactly as amended**.
- No regression on cleared steps — own read of `blueprint.md:786, 939-941, 1071-1074, 815-818, 1017-1020` + subtotal re-sum (89) — **intact**.
- `ErrorRetry` shared? — own `grep -rn "ErrorRetry" ui/src` — **local, defined twice, not exported**.
- `FilterPreviewResult` in `ports/board.ts` today — own grep — **absent**.
- All internal `step N` cross-references — own `grep -on "step [0-9]"` sweep, ~90 refs, spot-resolved — **one wrong (`:774`)**.

**DELEGATION LOG**
- none — every claim in this ruling was verified by my own Read/Bash on primary evidence.

**NOTES**
- Classified DESIGN-REVIEW from the target (a pre-execution blueprint), with the round-1 ruling binding under stare decisis; the dispatch's scope limits were honoured — cleared areas were re-touched only as regression spot-checks.
- One pre-existing, blueprint-wide ordering property, **not a finding**: every section step's in-step e2e (9d, 11, 12, 13, 17, 19, 23) depends on the shell wiring authored later at steps 25-27, so those specs only go green once Group D's shell steps land. This is uniform across the plan, predates the amendment, and is harmless — noted so an implementer isn't surprised when 9d's spec red-fails if run at its own step.
- No fixes attempted or dispatched — I hold no Write/Edit.