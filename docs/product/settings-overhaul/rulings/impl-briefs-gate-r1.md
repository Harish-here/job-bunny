# Judge ruling — settings-overhaul implementation-briefs gate (round 1)
Date: 2026-08-19 · Target: `/Users/harishamutha/.claude/ledgers/settings-overhaul/briefs/{be,ui}/`

MODE: DESIGN-REVIEW
STATUS: done
VERDICT: **CLEARS WITH CONDITIONS**

---

# FILED RULING — settings-overhaul brief-set gate (51 briefs, pre-execution)

**TARGET:** `/Users/harishamutha/.claude/ledgers/settings-overhaul/briefs/be/` (13 briefs + `be-tasks.json` + `plan.md`) and `/Users/harishamutha/.claude/ledgers/settings-overhaul/briefs/ui/` (38 briefs + 32 `task-N-files/` + `ui-tasks.json` + `plan.md`)
**CONTRACT:** `blueprint-be.md` §3/§11/§11a, `blueprint.md` §9/R2-rows/e2e-ledger/steps 9a-9d, `ux-notes.md` §3/§12/§17, `mockup.html`, repo `CLAUDE.md` — all read first-hand in `/Users/harishamutha/jb-wt-settings`
**PRECEDENT CONSULTED (not re-litigated):** `rulings/ui-gate-r2.md`

The brief set is executable as written. Every mechanical lint criterion passes on my own verification, the descope is architecturally sound on primary evidence, and the prior gate's outstanding conditions are carried through into the briefs faithfully. Six findings; two load-bearing, neither of which blocks the start of execution — both are one-line changes to material that lands late (BE task 8, UI task 22).

---

## WHAT I VERIFIED AND WHAT SURVIVED

**Lint criteria — all 51 briefs, verified by my own parse, not the sweep's word.** All 51 carry a `## DONE-WHEN`, a fenced single-line commit message in conventional-commit format, and zero attribution trailers (`co-authored-by:` / `generated with [claude` — regex sweep, zero hits). No duplicate commit subjects across the 51. No brief lists `CLAUDE.md`, `.claude/**`, `docs/product/**` or `profiles/harish/**` in a `FILES` block.

**Gate claim (report point 5) — confirmed exactly.** My own exhaustive scan of every `npm run`/`npx` occurrence across all 51 briefs: every BE brief's gate is exactly `npm run check`; every UI brief's is exactly `npm run check && npm run ui:check && npm run ui:build && npm run ui:e2e`. Precisely four narrower mentions exist — `ui/task-22:263,308`, `ui/task-37:235`, `ui/task-3:135` — matching the lead's own list, and none sits in a `## GATE` block; all four are prose or done-condition phrasing. I additionally confirmed `npm run --prefix ui check` and `--prefix ui e2e` are *valid* invocations (`ui/package.json` defines both `check` and `e2e`), so they misdirect nobody.

**Manifests (report point 1) — confirmed exactly.** 13 BE / 38 UI, contiguous numbering, **every dep edge forward-only, zero cycles, zero dangling refs**. Flags: BE `{4,6,8,9,10,11,12,13}`, UI `{36,38}`. Models: all `sonnet`, **no haiku**. Efforts: all `high` except UI `{3,15,23} = medium`. Every value matches both `plan.md` files.

**Descope (report point 2) — sound, and clean across all 38 UI briefs.** I read the lead's two blockers against primary evidence rather than accepting the characterisation:
- `src/adapters/browser/cdp-chrome/handles/browser_handle.ts:7-19` carries a class-level rule, verbatim: *"NEVER call browser.close() on a CDP-attached connection (a live-incident lesson…)"*, attributed to the 2026-07-25 incident, and pinned by the real regression test at `provider.test.ts:560` (*"close() is a no-op for a reused Chrome — never kills a process this run did not spawn"*). `blueprint-be.md` §11's F6 disposition requires exactly that call and itself records the semantics as *"unverified-against-this-repo, flagged for implementation-time confirmation."* The contradiction is genuine and not resolvable inside a brief.
- The cookie literal: `blueprint-be.md:532-560`'s `checkLinkedinSession` signature takes `cookieName`/`cookieDomainSuffix` as caller-supplied deps; `grep li_at src/` returns **one hit, in a test comment** (`provider.test.ts:680`). No production constant exists to source them from.

Both blockers are real. Declining to brief rather than guess is the correct call, and the C8 test is satisfied in the strong form: `ux-notes.md:569` binds *"Session and breaker share one card… seeing one without the other is misleading."* The descope omits **both** from the UI — `card-linkedin` is absent entirely, with `task-37:324` and `task-38:144-145` explicitly forbidding a breaker-only substitute **and** a placeholder slot. A dangling-identifier sweep for `LinkedinSessionStatus`, `getLinkedinSession`, `checkLinkedinSessionNow`, `LinkedinCard`, `card-linkedin`, `linkedin-session*`, `sessionHealth` across all 51 briefs and all 32 artifact folders returns hits **only** inside explicit "do NOT build" instructions (tasks 7, 31, 37, 38) or inside mockup fragments whose own brief names them as excluded. `LinkedinCard` and `sessionHealth`: zero hits anywhere. Tasks 7 and 31 each carry a STOP-if-already-present guard as claimed; **task 38 carries one too**, which the lead's report did not mention — a fourth affected brief, handled correctly.

**Task-22 self-correction (report point 3) — present, and broader than reported.** Every cited consumer is in the brief's `FILES` and `DONE-WHEN`: `Shell.tsx` fallback `'profile'→'landing'` (`:209`, `:299`), `HubPage.tsx` lines 43/58/66/74 (`:230-236`), `runDiagnosis.ts:228` (`:238`), `runDiagnosis.test.ts` (`:239`), `DiagnosisPanel.test.tsx` (`:240` — and it catches a **second** assertion at ~268-278 plus the test's own title string, which the plan's table omitted), `smoke.spec.ts` (`:259`), `profile-lifecycle.spec.ts:123` (`:261`, correctly leaving the three surviving `danger` gotos alone). `task-21-brief.md:144` and `:168` pin `RawConfigSection`'s default `selectedDoc` to `'profile.json'` exactly as claimed, sourced to the fragment's initially-active row.

**Batching (report point 4) — no blueprint substance dropped.** I built the full step→brief map from every brief's own "Blueprint steps covered" line. BE: steps 1-19, 28-35, 37-42 all covered; 36 is a "do not build" note honoured in `be/task-10:78`; **20-23 deferred**. I verified the plan's riskiest structural claim myself — `blueprint-be.md`'s numbering genuinely runs 19 → 20,21,22,23 → **28**; steps 24-27 do not exist, so nothing hides in that gap. UI: steps 1-33 and 35-38 plus 9a-9d all covered; **34 deferred**. I spot-checked the two batched steps most likely to conceal a drop — steps 12 and 17, both briefed as "component half" with no matching e2e brief. Reading `blueprint.md:719-728` and `:790-797` directly: both steps' "e2e halves" are *pure `page.goto` relocations* of existing `settings.spec.ts` tests, and task 22's Step 6 performs exactly those relocations (test 3 → `skills`, tests 1/5/8 → `where-jobs-come-from`). Nothing dropped. Likewise the four daemon-state e2e deleted from `settings.spec.ts` by task 22 are explicitly re-created in `task-37:309-310,343`, so the ledger's REPLACE disposition is honoured end to end.

**Prior-gate conditions carried through — this is the strongest part of the set.** `ui-gate-r2.md` conditioned clearance on folding R2-F1 and R2-F2 into the blueprint before steps 9d and 35 execute. The blueprint was amended (`blueprint.md:1323-1327`), and the briefs carry the amendments intact: `task-24` DONE-WHEN has cases **(d) loading** and **(e) error** with the exact failure-independence semantics (caps table blocked on the same request, rules summary independent), and explicitly annotates case (b) as *not* proving failure-independence; `task-35:223` and `task-38:184-190,242` carry R2-F1's group-membership assertion inside `[data-qa="health-group-needs-action"]` **and** the `settings-link` → `{section:'delivery'}` navigation half. R2-F5's `ErrorRetry` consolidation is task 6.

**Artifact fidelity — verified by my own byte comparison, not the "82/82" claim.** All 32 `design-scale.md` copies are byte-identical to each other and a **verbatim substring of `ux-notes.md` §3**. All 23 `mockup-style.css` copies are byte-identical to each other and verbatim against `mockup.html`'s single `<style>` block (modulo one trailing newline). Of 23 `mockup-fragment.html` files, **21 are byte-exact contiguous slices of `mockup.html`**; the 9 folders with no fragment (6, 10, 12, 15, 16, 17, 19, 20, 29) match the plan's declared list exactly. Two deviate — see finding 4.

---

## FINDINGS

**F1 — load-bearing — BE task 8 ships a complete, flagged, port-widening vertical slice with zero consumers this epic, and no brief says so.**
BE task 8 (`blueprint-be` §3 steps 14-19) adds `readBreaker` to the `BoardSource` port in `src/ports/board.ts`, plus `cli/wire/board_linkedin.ts`, `app/features/linkedin/routes.ts` + barrel, and route tests. UI task 31 then adds `getBreakerStatus` (`GET /api/linkedin/breaker`) to `operate.api.ts` (`task-31:161,198`). But the **only** surface that renders breaker state is `card-linkedin` (`blueprint.md:237`), which is deliberately not built. My sweep of `BreakerStatus` / `getBreakerStatus` / `linkedin-breaker` across all 38 UI briefs returns hits only in task 7 (type barrel), task 31 (the API function) and tasks 37/38 (as explicit *exclusions*). Net effect: a **flagged, `src/ports/board.ts`-widening change on a stability-sensitive surface lands with no user-visible benefit**, and UI task 31 adds an uncalled exported function. This is unacknowledged in both briefs — and it is inconsistent with task 31's own stated standard, which justifies omitting `getLinkedinSession` precisely because it "would be dead surface"; applied to `getBreakerStatus`, that test yields the same answer. `be/task-8:79` discusses batching only. **Route: advisor — either defer BE task 8 and task 31's `getBreakerStatus` alongside the rest of the R17 slice (which also makes `board_linkedin.ts` one brief instead of two when it unblocks, per §11's F8 which scopes that file as "breaker + session"), or record the pre-wiring as deliberate in both briefs. Not a defect in either brief's internals; a scope call only the advisor owns.**

**F2 — load-bearing — UI task 22 is unflagged under the letter of the rule but fails the lead's own widened standard.**
`be/plan.md:47-51` flags BE task 4 *despite* it touching none of CLAUDE.md's literal `pipeline/ runner/ adapters/ ports/` list, on the explicit reasoning that blast radius, not folder, is what the flag exists to catch. UI task 22 is the UI analogue of exactly that argument: it is the set's single widest join (14 deps), rewrites the `SettingsSection` union that `Route` literals across the codebase are checked against, touches **18 files in one mandatory atomic commit** including three e2e specs, and is the pinch point behind which tasks 23-30 and 37-38 are all stranded. `ui/plan.md:140-141` dismisses it in one line — "task 22 still touches only `ui/`, so it stays unflagged" — which applies the literal folder rule the plan already chose to widen elsewhere. The brief itself is excellent; the issue is review coverage, not authorship. **Route: advisor — one-line change, `"flagged": true` for UI task 22 in `ui-tasks.json`. Cheap, and it buys an adversarial review on the one commit whose failure strands the most work.**

**F3 — cosmetic — `ui/task-37-brief.md:325` contradicts `:324` on the card count, inside DONE-WHEN.**
`:324` states, emphatically, *"The page renders FOUR cards in this brief."* The very next bullet, `:325`, reads *"The **five** cards' independent query scoping is preserved"* — then lists only three GETs (`/api/daemon`, `/api/profiles/:name/doctor`, `/api/secrets`), i.e. four cards' worth. A pre-descope residual in a done-condition. **Route: executor-lead — one word.**

**F4 — cosmetic — 2 of 23 mockup fragments are not byte-verbatim; the "82/82 byte-fidelity" claim is overstated by one line each, with nil impact.**
`ui/task-33-files/mockup-fragment.html` and `ui/task-37-files/mockup-fragment.html` each replace `mockup.html:648`'s separator `<!-- S7 — Operate, degraded -->` with a rewritten `<!-- ===== S7 (degraded Operate) ===== -->`. I bisected both: the head slice is verbatim, and the S7 `<section>` body (4,366 chars) is verbatim — **only the editorial comment line differs**. Impact on the briefs' COPY-THEN-VERIFY id procedure is zero, because S7 carries **no `data-qa` ids at all** (I extracted: empty set), by the mockup's own design note at `mockup.html:701` — *"S7's cards intentionally omit `data-qa` — each canonical id already renders exactly once on S6 (rule 7); duplicating them here would break document-wide uniqueness."* Recorded so the fidelity claim is not relied on as absolute in a later gate. **Route: none required; correct the claim, not the files.**

**F5 — cosmetic — `ui/plan.md:8-9`'s "no UI task carries a dependency on a BE task" is literally false, though the graph handles it correctly.**
UI task 7 hard-depends on BE deliverables — it imports from `src/app/features/linkedin/index.ts`, `preview/index.ts` and `daemon/index.ts`, barrels created by BE tasks 8, 10, 11-13 (neither `linkedin/` nor `preview/` exists in `src/app/features/` today). The **briefs** handle this properly: `task-7:151-175` carries an explicit STOP-and-report-blocked guard for exactly this case, and I traced every downstream BE-consuming task — 14 (`deps [7,13]`), 32 (`[31]`→`[7]`), 33 (`[16,31,32]`), 36 (`[31]`) — and confirmed **all are transitively gated behind task 7**, making it a single, guarded choke point. So the set degrades to *blocked*, never to a wrong build. But the plan's blanket prose, if believed, invites scheduling the two sets in parallel. **Route: advisor — record "BE set completes first" as an explicit precondition on the UI invocation rather than a plan-prose assumption.**

**F6 — cosmetic — the deferred slice is four blueprint steps, not two, in the summary that reached this gate.**
`be/plan.md:13-15` is **correct**: §3 steps **20, 21, 22, 23** are unbriefed. I confirmed each against `blueprint-be.md` — 20 (`session_check.ts`), 21 (`ports/board.ts` `LinkedinSessionStatus`), 22 (session route), 23 (its test) — and confirmed the 24-27 numbering gap is genuine, so nothing hides there. The report reaching this gate described the exclusion as "steps 20-21". The artifact is right and the summary is wrong; anyone reconciling remaining scope from the summary under-counts the deferred work by two steps. **Route: advisor — note only.**

---

## CONDITIONS ON THIS CLEARANCE

1. **F1 and F2 are decided before their briefs execute, not before the set starts.** Both are advisor scope calls, not brief defects. BE tasks 1-7 and 9-13 and UI tasks 1-21 are unaffected and may begin immediately.
2. **F3 is fixed before UI task 37 runs** — one word in a done-condition.
3. **F5's ordering precondition is made explicit on the UI workflow invocation.** The BE set must complete before the UI set starts; task 7's STOP guard is the safety net, not the plan.
4. **F4 and F6 are record-corrections only.** No file changes.
5. **No re-gate required.** Every condition is verifiable against this ruling by the advisor or at PR-time change-review.

---

**EVIDENCE**
- 51 briefs carry DONE-WHEN + fenced conventional commit + zero attribution trailers — own Python parse of all 51 — **confirmed, zero failures, zero duplicate subjects**.
- Gate-command exclusivity — own exhaustive scan of every `npm run`/`npx` line in all 51 — **exactly 4 narrower mentions, matching the lead's list, none in a GATE block**; both `--prefix ui` forms validated against `ui/package.json`.
- Manifest integrity — own JSON parse of both `tasks.json` — **contiguous, forward-only, acyclic, no dangling deps**; flags/models/efforts match both plans.
- CDP-disconnect blocker — own read of `browser_handle.ts:7-19` + `provider.test.ts:560` — **the "NEVER call browser.close()" rule and its 2026-07-25 regression test are real and verbatim as reported**; `blueprint-be.md` §11 F6 requires the contradicting call.
- Cookie-literal blocker — own `grep li_at src/` — **one hit, in a test comment**; no production constant exists.
- Descoped identifiers across all 51 briefs + 32 artifact folders — delegated exhaustive grep, returns read by me — **every hit inside an explicit exclusion or an excluded fragment; `LinkedinCard`/`sessionHealth` zero hits**.
- Blueprint-be steps 24-27 — own Python scan of every numbered step — **genuinely absent (19 → 20-23 → 28)**; plan's gap claim true.
- UI steps 12/17 "e2e halves" — own read of `blueprint.md:719-728, 790-797` — **pure goto relocations, all performed in task 22 Step 6**; no substance dropped.
- Prior-gate R2-F1/R2-F2 carry-through — own read of `task-24` DONE-WHEN, `task-35:223`, `task-38:184-190,242` vs `blueprint.md:1323-1324` — **present and semantically exact**.
- Artifact fidelity — own byte comparison of 23 fragments / 23 CSS / 32 design-scale against `mockup.html` and `ux-notes.md` — **21/23 fragments byte-exact; 2 differ by one comment line only (S7 body verbatim, zero `data-qa` ids in it); CSS and design-scale verbatim**.
- Breaker has no UI consumer — own grep of `BreakerStatus|getBreakerStatus|linkedin-breaker` across 38 UI briefs — **hits only in the barrel, the API fn, and two exclusion notes**.
- Task-22 correction completeness — own full read of `task-22-brief.md` — **all 7 cited files present, plus a second `DiagnosisPanel.test.tsx` assertion the plan omitted**.
- Task-36's dependency soundness — own `grep putSecret ui/src` (`wizard/wizard.api.ts:20`) and `grep api/secrets src/app` (`secrets/routes.ts:75-76`) — **both reuse targets real; dep on 31 is the structural `operate/` folder creation, correct**.
- BE task 1 two-pair compliance — own `ls src/core/config/` — **exactly 2 impl files at cap; the brief's subfolder-module remedy is the CLAUDE.md-prescribed one**.
- Protected paths — own parse of all 51 FILES blocks — **zero references to `CLAUDE.md`, `.claude/**`, `docs/product/**`, `profiles/harish/**`**.

**DELEGATION LOG**
- executor-fast — mechanical lint extraction across 51 briefs (gate/commit/done-when/marker/trailer occurrences) — returned; **its PASS-shaped characterisations were not relied on — I re-derived the gate, commit, DONE-WHEN and trailer results myself from the files**.
- executor-fast — exhaustive grep for 8 descoped LinkedIn identifiers across both brief dirs + artifact folders, raw hits with context — returned raw; **judged by me**.

**NOTES**
- Classified DESIGN-REVIEW from the target itself (51 pre-execution briefs measured against frozen blueprints), and held the premortem law throughout: I assumed the unattended loop had already failed and worked backward — which is what surfaced F1 (the flagged port change nobody consumes) and F2 (the widest-blast-radius commit carrying no adversarial review), neither of which violates any line on the page.
- `ui-gate-r2.md` was consulted as context only, per the dispatch; nothing it CLEARED was re-litigated. Its two outstanding conditions were checked for *carry-through into the briefs*, which is new ground, not re-review.
- One pre-existing repo condition, **not a finding against this set**: `src/core/schedule/` already holds four implementation files against the two-pair rule's cap of two. It predates these briefs and no brief adds to it.
- No fixes attempted, authored, or dispatched — I hold no Write or Edit.
