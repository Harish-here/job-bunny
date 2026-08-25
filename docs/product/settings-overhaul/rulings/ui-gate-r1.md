MODE: DESIGN-REVIEW (premortem). STATUS: done — verdict formed on primary evidence read first-hand.

---

# FILED RULING — settings-overhaul UI-blueprint gate

**TARGET:** `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/blueprint.md` (974 lines)

## VERDICT: **BLOCKED**

Two defects are load-bearing enough that implementing as written reproduces the previous epic's failure mode. Both need a product-ui amendment before this clears; the remaining findings are conditions or notes.

The blueprint is, on the whole, unusually disciplined — contract fidelity is genuinely strong (§3 probe), the data-qa count is exactly right, and most done-conditions assert effects. The defects are concentrated in what it *omitted*, not what it invented.

---

## FINDINGS

### F1 — **BLOCKER** — The Landing screen (S1) has zero implementation steps

The default settings route has 10 of 89 data-qa ids, 3 named new components, 3 rows in §3 State & Data — and **no step in Groups A–F builds any of it**.

- Mapped: `blueprint.md:128-135` names `LandingSection.tsx`, `LandingCapsTable.tsx`, `LandingRulesSummary.tsx`.
- Routed: `blueprint.md:381` makes `landing` the default for bare `#/settings`.
- Built: `awk '/^### Group/,0' blueprint.md | grep -c "LandingSection\|LandingCapsTable\|LandingRulesSummary"` → **0**.
- `blueprint.md:622` (step 25) asserts `SectionBody`'s switch grows to 12 cases "one per new section component from Groups B–D" — the landing case has no component to mount.
- §5 Requirements Coverage maps no requirement to a Landing step.

Premortem: the implementer works the numbered list; the default route ships blank or throws. This is not an implementation-time note — it needs steps, e2e, and §12 state coverage authored.
**Route: product-ui amendment.**

### F2 — **BLOCKER** — Four e2e tests in `settings.spec.ts` are silently orphaned; the file's test count is misstated

`ui/e2e/settings.spec.ts` has **12** tests, not the 14 the blueprint asserts twice (`blueprint.md:53`, `blueprint.md:963`, both claiming "confirmed by full read"). Verified: `grep -c "test(" ui/e2e/settings.spec.ts` → 12.

The blueprint assigns dispositions to 8. The four unaddressed ones are `settings.spec.ts:252, 280, 302, 332` — the daemon degraded / healthy / **unreachable** / **loading-skeleton** suite (lines 252–363, a third of the file). Step 18 (`blueprint.md:544-546`) explicitly removes the markup they assert:

> "Remove the inline 6-branch daemon-status JSX block (lines ~146-225); replace with one compact line"

Step 18's done-condition only relocates `ScheduleSection.test.tsx`'s **unit** tests. The e2e tests go red with no stated destination. These are precisely the tests the blueprint itself cites as its `data-qa` state-discrimination precedent (`blueprint.md:58-59`, citing `settings.spec.ts:270-363`) — cited as authority, then left unaccounted.

Aggravating: `settings.spec.ts:302` pins *"the unreachable-daemon error state, and it is never mistaken for the degraded state"*, and step 16 (`blueprint.md:533`) deliberately excludes `api-unreachable` from `daemonStatusWord` as "caller's concern" — assigning it to no caller. ux-notes §12:481 requires it as a *first-class* daemon state.
**Route: product-ui amendment** (state survive/adapt/replace per test; assign the `api-unreachable` owner).

### F3 — **MAJOR** — Deleting `HubPage.tsx` removes the only entry point to profile creation

Step 29 rewrites `HubPage.tsx`; step 37 deletes `hub.spec.ts`. `HubPage.tsx:125-127` is the **only** user-reachable navigation to the onboarding wizard:

```
onClick={() => navigate({ name: 'onboarding' })}
...
Set up a new profile
```

Verified: `grep -rn "onboarding" ui/src/` returns only `Shell.tsx:110` (an *automatic* redirect gated on `noProfiles`), `router.ts:9`, and this call site. `hub.spec.ts:174` pins it. OperatePage's 5 cards contain no equivalent.

R28 ("new-profile creation" = Won't) means *do not build new* — it does not authorise deleting a shipped control, and CLAUDE.md lists profile creation in the board's write surface. The blueprint's §3 even cites `POST /api/profiles` as "existing" (`blueprint.md:361`) without mapping any UI to it.
**Route: user decision** (accept the regression, or product-ui amendment adding the control to Operate).

### F4 — **MAJOR** — Three interactive controls have no effect-asserting done-condition (the burned failure class)

Sampled 20 interactive steps across A–E. **17 pass** cleanly — step 19(c) even asserts a *negative* effect (doc not written), step 30(d) asserts the outcome payload is used, step 36 asserts the secret never enters the DOM. That is strong work. Three fail:

| Control | Where mapped | Gap |
|---|---|---|
| `daemon-autostart` | `blueprint.md:212, 673-676` | Step 30's done-conditions (a)–(d) cover stop/start only. Nothing asserts the switch fires `setAutostart`, and **neither `AutostartOutcome` value is rendered under test**. Directly violates the R20 ruling's "every typed outcome rendered." |
| `daemon-pause-all` | `blueprint.md:211, 670-672` | Step 32 unit-tests the *hook's return shape*. No done-condition that clicking the button in `DaemonCard` invokes the fan-out or renders the partial-failure line. An inert button passes. |
| `linkedin-session-check` | `blueprint.md:219, 719-721` | Behaviour described in prose ("no optimistic flip… shows `Checking…`"); step 34's done-conditions (a) and (b) assert only stubbed-GET rendering. Nothing asserts the POST fires. An inert button passes. |

Minor same-class: `discard-button` (step 5 asserts save + validation, never discard) and `raw-key-badge-*` navigation (`blueprint.md:191` "click navigates to owning section", no done-condition).
**Route: product-ui amendment** (add effect done-conditions; these are one line each).

### F5 — **MAJOR** — Reuse-first violation: a duplicate `RunResult` module, contradicting the shipped one's deliberate posture

`blueprint.md:342` specifies a **new** `ui/src/features/settings/sections/landing/runResult.types.ts` "mirroring `ops/observability/run/result.ts:4-20` **field-for-field**".

`ui/src/features/runs/runResult.ts` (183 lines, with `runResult.test.ts`) already exists and already exports exactly the Landing card's two data needs — `getBiggestDrop` and `newMatchCount`, plus `getFunnelStages`/`computeRetention`. The blueprint never mentions it; `ui/src/features/runs/` is absent from its "read first-hand" list (`blueprint.md:951-968`).

Worse, the shipped module's header documents the opposite approach for a stated reason:

> "`RunDetail.result` … are opaque `unknown` at the port boundary … The UI is on the other side of that same boundary — it **narrows defensively rather than importing the zod schema**, so a malformed/absent blob degrades to 'no funnel to show' instead of a render crash."

A field-for-field mirror of a value that arrives as `unknown` is false type safety. blueprint-be §2 says "product-ui must hand-type `RunResult`'s shape in `ui/`" — it does not say *create a second one*. Compounds F1 (this is Landing's data).
**Route: product-ui amendment** (reuse `runs/runResult.ts`; extend it if a field is missing).

### F6 — **MAJOR** — Step 9's stated edit does not exist; the BE type-barrel dependency is understated

`blueprint.md:445-447` instructs: *"extend the existing `from '../../../../src/app/features/daemon/index.ts'` re-export line."*

Verified in `ui/src/lib/api/types.ts`: there are exactly **four** re-export blocks — `board`, `config`, `profiles`, `runs`. **No daemon line exists.** And `src/app/features/daemon/index.ts` exports exactly one symbol: `export { makeDaemonRoutes } from './routes.ts';` — no types at all. The repo's actual convention for daemon types is hand-typing in `ui/src/features/wizard/wizard.types.ts` (`DaemonState`, `DaemonStatus`), which the blueprint elsewhere reuses.

So all three of the blueprint's declared BE-coordination flags resolve harder than it states — `linkedin/` and `preview/` feature folders do not exist (confirmed: `ls src/app/features/` → appinfo, board, config, daemon, doctor, intents, personas, profiles, runs, secrets), and `daemon/` exports no types. blueprint-be §2 specifies `{outcome}` shapes but names no exported type identifiers. Step 9's "one-line BE-side addition" framing is optimistic; it is three new/extended barrels plus type identifiers that no contract names.
**Route: product-ui amendment** (correct step 9's edit description) + **BE bounce** (pin the three type identifiers in blueprint-be §2).

### F7 — **MAJOR** — ux-notes §12 empty/error states are asserted in prose only; three are entirely absent

Spot-checked 3 screens' steps against §12's five-state table:

- **S2/S4 empty** — §12:478 and its *added* rule (§12:490) mandate: *"No rules — nothing is dropped for this reason"* + inline `[Add]`, because "an empty list and a permissive list look identical and mean opposite things." Blueprint mentions: **nothing**. `grep "No rules\|nothing is dropped" blueprint.md` → none. Steps 11 and 13 have no empty-state done-condition.
- **S5 empty** — §12:480 mandates *"Not created yet — saving will create it."* Blueprint mentions: **nothing**.
- **S6/S7 error** — §12:481's `api-unreachable`-as-first-class: see F2.
- **S3** — clears; step 19(c) covers the cross-field error naming both fields and consequence.

§8 (`blueprint.md:896-903`) makes a blanket prose claim that "every mockup skeleton state maps to a real `isLoading`/`isPending` branch," but no section step carries a loading or empty done-condition. Prose-shaped state promises with no done-condition are the second half of the previous epic's failure signature.
**Route: product-ui amendment.**

### F8 — **MINOR** — Completeness is asserted against the mockup's instantiated ids, not ux-notes §17's templated contract

The 89-id count is **correct** — I re-ran it: 89 unique across 93 occurrences, matching `blueprint.md:102-105` exactly, and the group subtotals sum to 89. Both exclusions (`settings-search` at `blueprint.md:815`, `daemon-start-fallback` at `blueprint.md:816`) are argued with named reasons, not silent. Ten spot-checked mappings are correct, including two that show real care: `raw-key-badge-rank-weights` → no click target (matching blueprint-be §2's "UI must not form-edit" on point weights) and `landing-cap-row-max-age-days` → "gates freshness, never caps jobs" (matching the spec amendment).

But ux-notes §17:627 specifies `health-group-{needs-action|not-configured|ok}` as a **template**. The mockup only instantiated `health-group-ok`; the blueprint maps only that one (`blueprint.md:222`), and step 35 describes the three groups without assigning the other two ids. QA pairs mechanically off §17, not the mockup.
**Route: implementation-time note.**

### F9 — **MINOR** — File-split contingency is cited but never applied

§0 correctly cites the 400-line cap (`blueprint.md:64-67`, verified against `test/invariants/filesize.test.ts`), and §NOTES names a sibling-file strategy — but no step names a *specific* split for a specific at-risk file. The likeliest candidate is `WhereYouWorkSection.tsx` (ux-notes' "hero screen": two cards, locations, work-types, three chip inputs, severity select, conflict notice), given `FiltersSection.tsx` is 342 lines today for a comparable load. Current sizes leave headroom elsewhere (`SettingsPage.tsx` 90, `HubPage.tsx` 203, `ScheduleSection.tsx` 315 losing ~80).
**Route: implementation-time note.**

### F10 — **COSMETIC** — Citation slip in the Design Scale correction

`blueprint.md:28-29` cites `ScheduleSection.tsx:176,181,193,207,218`; line 193 is not a `-strong` site (actual: 176, 178, 181, 206, 207, 218). Does not affect the conclusion.

---

## HYPOTHESES TESTED THAT SURVIVED (the plan is *not* wrong here)

- **The "-strong token variant" correction is a genuine codebase fact, honestly recorded — not invented.** Verified `ui/src/index.css:33,36` (`@theme` mappings) and `:83,86` (light literals `#a04a06`/`#26703f`), plus dark at `:127,130`, and `ui/src/lib/tokens.test.ts:37,40,78,81` pins all four. Shipped usage confirmed across `ScheduleSection.tsx`, `DangerZone.tsx:77`, `SearchUrlsSection.tsx:132`, `DaemonDegradedBanner.tsx`, and `badge.tsx:17`. The deviation is real *and* necessary: ux-notes §3's colour table lists `text-attention`/`text-success` utilities while §14:535-537 declares those same tokens "used for icons, 1–2px borders and tints only, never as text colour… this is a hard rule." The blueprint resolves an internal ux-notes contradiction in favour of the accessibility rule and the shipped convention, and records it explicitly in §0 and §8 as a binding correction rather than applying it silently. §3:215's "any value not in this table is a defect" makes this a third exception — declared, not smuggled. **This probe clears.**
- **Contract fidelity is sound.** All 20 §3 data rows trace to real blueprint-be §2 rows read first-hand: `schedule.skipNext` (new, §3.5-9), `GET /api/linkedin/breaker`, `GET /api/linkedin/session` + `POST .../check`, `POST /api/profiles/:name/preview/filter`, cap-hit markers on the extended soft-errors endpoint, cleanup TTLs, Notion `mirror`/`dryRun`, connector read-only, ranking lists, `companies.avoid`, `filter.json.timezones`. No invented endpoint or field found. The four cleanup field names in step 22 all verified real (`src/routines/cleanup/cleanup.ts:43`, `src/ports/connector.ts:11-12`). The blueprint correctly declines to claim a `maxProbesPerRun` cap-hit signal, matching BE's "no signal exists today."
- **The "resume not parsed" doctor-check flag is correct and honestly handled.** Verified: no such check exists. `src/ops/doctor/` emits `profile-parses`, `filter-parses`, `wire`, `empty-lanes`, `env-tokens`, `daemon-liveness`, `claude-cli-on-path`, `cdp-reachable`, `sqlite-db-openable`, `config-legacy-divergence`, `sqlite-path-retired`, `linkedin-inventory-freshness`, `notion-db-reachable`, `telegram-bot-token` (cross-checked against `hub.model.ts`'s `CHECK_TO_CARD`) — nothing resume-related. `blueprint.md:834-841` flags it as a possible BE bounce with an explicit fallback ("render under 'Not configured' with no destination rather than inventing a check"). Exactly right.
- **`src/core/normalize_token/` correctly identified as BE-new.** Confirmed absent from `src/core/` (13 modules, `datetime/` is still the only dependency-free one). The blueprint flags the required CLAUDE.md amendment as a precondition for `ui:build`.
- **The `pacing-fast-ack` non-blocking ruling is right, and is itself an anti-invention guard.** ux-notes §7:325 says the checkbox is revealed and cleared on preset switch — it never says it gates save. Step 20 asserts Save proceeds with the ack unchecked *specifically so a later reviewer doesn't "fix" it into a block that was never designed.* That is the correct instinct against this pipeline's burned failure class. (Minor unstated detail: §7:325's "unchecking or switching preset clears it" is not carried into step 20.)
- **The `#/setup` route/e2e question — ruled: honest consequence, not a contradiction.** The boundary ruling's rationale ("so existing e2e selectors survive") is satisfied at the level it operates: the *route string* survives, so `page.goto('/#/setup')` still resolves, and `hub.spec.ts:80`'s sidebar-nav test is explicitly relocated (step 29). The card set genuinely changes wholesale — 6 cards → 5, no 1:1 content overlap — so the 6-card assertion could not survive any implementation of the ruled boundary. `blueprint.md:818` argues this in §6 rather than burying it. **No finding on the replacement itself.** The finding is narrower and sits at F3: one *behaviour* inside the deleted page (wizard entry) was not carded, and at F2's sibling — `hub.spec.ts`'s other four tests (doctor-finding-under-card, schedule-vs-daemon banner, card action routing) get only the blanket "every assertion that still applies" clause at `blueprint.md:761-763`, which is a judgment the implementer is left to make.
- **R20 is otherwise genuinely designed.** The long-wait Start affordance is real, not a spinner-by-another-name: `blueprint.md:666-669` specifies the optimistic flip within 400ms to *"Starting… this can take up to 35 seconds"*, explicitly names it as a divergence from the shared Doherty ≤400ms pattern per BE F9, and step 30's done-condition (c) stubs a >1s delayed response and asserts the copy is visible *before* resolution. `daemon_unresponsive` (done-condition b) must render "visibly distinct, non-success" styling; `child_unresponsive` (d) must surface the pid. Only `AutostartOutcome` is unpinned — F4.
- **No pre-gate-forbidden control is built.** Breaker reset is not merely omitted — step 34's done-condition (b) asserts its *absence* mechanically (`getByRole('button', {name: /reset/i})` returns zero). Connector is display-only with an e2e proving no interactive role (step 21). Rank point-weights are raw-only with no click target. New-profile creation is not built (though see F3 for the inverse problem).

---

## CONDITIONS TO CLEAR

1. Author Group-B steps for `LandingSection.tsx` / `LandingCapsTable.tsx` / `LandingRulesSummary.tsx` with e2e and §12 state coverage — reusing `ui/src/features/runs/runResult.ts` (F1 + F5).
2. State survive/adapt/replace for all **12** `settings.spec.ts` tests, especially the four daemon-state e2e at lines 252–363; assign an owner for `api-unreachable` (F2).
3. Rule on the wizard entry point: carry it onto Operate, or record the regression as accepted (F3) — **user decision**.
4. Add effect done-conditions for `daemon-autostart` (both `AutostartOutcome` values), `daemon-pause-all`, `linkedin-session-check` (F4).
5. Correct step 9's edit description; bounce the three type identifiers to blueprint-be §2 (F6).
6. Add empty-state done-conditions for S2/S4 and S5 (F7).

F8–F10 are implementation-time notes; they do not gate.

---

**EVIDENCE**
- data-qa count claim (89) — own `grep -o … | sort -u | wc -l` on mockup.html — **confirmed exactly**, 89 unique / 93 occurrences; group subtotals sum to 89.
- `-strong` tokens genuine vs. invented — own grep of `ui/src/index.css`, `ui/src/lib/tokens.test.ts`, repo-wide usage — **genuine**, correction honestly recorded.
- Landing steps exist — own `awk`-scoped grep over the Groups A–F region — **zero hits**, blocker.
- `settings.spec.ts` = 14 tests — own `grep -c "test("` — **false, 12**; four dispositions missing.
- Wizard entry point survives the rewrite — own `grep -rn "onboarding" ui/src/` + read of `HubPage.tsx:125-127`, `Shell.tsx:110`, `hub.spec.ts:174` — **only entry point, deleted**.
- `RunResult` must be hand-typed anew — own `ls ui/src/features/runs/` + read of `runResult.ts` header and exports — **already exists**, with the opposite documented posture.
- Step 9's "existing daemon re-export line" — own `cat ui/src/lib/api/types.ts` + `cat src/app/features/daemon/index.ts` — **neither exists**.
- BE contract rows for all §3 data — own `sed` read of blueprint-be.md:254-287 — **every row traced, no invention**.
- "resume not parsed" doctor check — own grep of `src/ops/doctor/` + `hub.model.ts:CHECK_TO_CARD` — **absent**, blueprint's flag correct.
- `src/core/normalize_token/` — own `ls src/core/` — **absent**, correctly flagged as BE-new.
- Cleanup TTL field names — own grep of `src/routines/cleanup/`, `src/ports/connector.ts` — **all four real**.
- ux-notes §12 empty-state copy present in blueprint — own grep for `"No rules"`, `"nothing is dropped"`, `"Not created yet"` — **zero hits**.
- Wired-action sample (20 steps, groups A–E) — own read of `blueprint.md:369-772` — **17 assert effects, 3 do not**.
- DangerZone `data-testid` claims, `ChipRow` line range 26-75, checkbox convention, file sizes — own greps — **all accurate**.

**DELEGATION LOG**
- executor-fast — verbatim extraction of blueprint-be §0/§2/§3/§7/§9/§10 — returned locations and characterisations rather than verbatim text; **discarded, re-read `blueprint-be.md:250-300` myself**.
- executor-fast — verbatim extraction of ux-notes §2/§3/§7/§12/§14/§17 + e2e test titles — returned usable verbatim material; **§12/§17 independently re-read by me before use**; test counts independently re-verified by own `grep -c`.

**NOTES**
Classified DESIGN-REVIEW from the target itself (a pre-execution blueprint), matching the dispatch's framing. No fixes attempted or dispatched — I hold no Write/Edit. All eight requested probes were run; probes 2 (invented constraints), 3 (contract fidelity), 4 (completeness), and the R20/forbidden-control half of probe 6 substantially clear — the failures cluster in omission (probes 1, 5, 8) rather than invention, which is the inverse of the previous epic's profile and worth noting for whoever amends.