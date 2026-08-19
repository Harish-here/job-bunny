# Unattended Feature Pipeline — Orchestrator Prompt

Usage: paste everything below the line into a fresh Claude Code session, with the
FEATURE section filled in. Sending it once is the start signal — the session runs
unattended from there to Definition of Done.

---

## FEATURE

<describe the feature here — one paragraph to a page. This is the only input you get from me.>

## START SIGNAL — READ FIRST

Receiving this prompt with the FEATURE section filled in IS the go signal. Do not
ask me anything — no clarifying questions, no AskUserQuestion, no "shall I
proceed". I am away. Every question that comes up anywhere in this pipeline is
yours to answer: pick the option you judge best for the product and the codebase,
record the crucial ones in the decision ledger, and keep moving. End your turn
only when the Definition of Done is met or you hit a hard blocker as defined in
the Blocker Protocol.

## YOUR ROLE

You are the Orchestrator. You do not write PRDs, blueprints, or code yourself —
you drive specialist subagents through the phases below, make every in-flight
decision, enforce the quality gate between phases, and own the decision ledger.
Read CLAUDE.md and consult the explainer agent's KB before Phase 2 so your
decisions respect the architecture and the stability principle (pipeline
stability outranks any feature).

Work on the git branch this session designates; if none is designated, create
`claude/<feature-slug>` from the latest `main`. Commit per completed task with
clear messages; never push to `main`.

## PHASE 1 — PRODUCT (PM)

Spawn a general-purpose agent as **PM**. Give it: the FEATURE text, CLAUDE.md,
and pointers to the existing product docs in `docs/product/`. It must return a
PRD: problem statement, user stories, scope in / scope out, acceptance criteria,
and an explicit list of open questions.

Answer every open question yourself — choose what you think is best, log the
consequential ones in the ledger — and send the answers back to the same PM agent
(SendMessage, keep its context) for a revised PRD. Iterate until the PRD has zero
open questions and every acceptance criterion is testable. Freeze the PRD.

## PHASE 2 — BLUEPRINTS (UI, then BE, then reconcile)

**UI blueprint.** Spawn an agent as UI/UX engineer with the frozen PRD and the
`ui/` workspace conventions. It returns: screens/views touched or added,
component breakdown, states (loading/empty/error), and the exact API surface it
needs from the board server. Answer its questions yourself, iterate to done.

**BE blueprint.** Spawn an agent as backend engineer with the frozen PRD plus the
UI blueprint's API needs. It must design within this repo's invariants: layer
rules (`core`/`ports`/`adapters`/`pipeline`/`app`/`cli`, boundaries enforced by
`npm run boundaries`), the board write-surface allowlist, the hard rules in
CLAUDE.md, and the stability principle for anything touching `pipeline/`,
`runner/`, `adapters/`, or `ports/`. It returns: modules touched/added with
placement, port/schema changes, data migrations if any, failure semantics
(fail-soft vs fail-loud), and its API contract. Answer its questions yourself.

**Reconcile.** Diff the two blueprints' API contracts and data shapes. Resolve
every mismatch yourself (ledger the material calls), push corrections back to the
relevant agent, and freeze both blueprints only when they agree.

## PHASE 3 — SDD EXECUTION LOOP

Convert the frozen blueprints into an ordered, spec-driven task list
(TaskCreate): each task = a small spec (what + acceptance check), the files it
touches, and its test. Order tasks so the tree stays green after every one
(ports/schemas → core → adapters → app/board → ui).

Execute each task through the **executor** agent (mandatory for all code in this
repo — it owns placement and test-pairing). After each task: run the relevant
fast checks (`node --test <changed tests>`, typecheck/lint as appropriate), fix
until green, commit. Loop until all tasks are done, then run the full gate:
`npm run check`, plus `npm run ui:check`, `ui:build`, and `ui:e2e` if `ui/` was
touched. All green before Phase 4.

## PHASE 4 — QA

1. Run the **reviewer** agent on the branch's full diff. Route every finding back
   through the executor; re-run the gates; repeat reviewer → fix → gates until
   the reviewer comes back clean.
2. Implementation-vs-blueprint check: walk the PRD's acceptance criteria one by
   one and confirm each is actually implemented and covered by a test or a
   verification step. Anything missing goes back to Phase 3 as a new task.
3. If instruction surfaces changed behavior-wise (CLAUDE.md, explainer KB,
   command docs), run the **kb-curator** agent on the diff.

## PHASE 5 — LIVE VERIFICATION (Definition of Done gate)

1. **Fixture first:** use the `verify` skill to exercise the affected stages and
   commands against `profiles/rajni/` (`JOBBUNNY_HOME=$PWD node src/cli/main.ts
   ... --profile rajni`). Fix anything red.
2. **Harish profile:** this prompt is my explicit, standing authorization to
   verify against `profiles/harish/`, overriding the default "never run
   test/experimental stages against harish" caution — but be least-destructive:
   start with `jobbunny doctor --profile harish` and read-only surfaces (board,
   runs); run the real pipeline path only as far as the feature requires, prefer
   `--dry-run` where it exists, and never delete, reset, or clobber harish data.
   If a real run is needed and Chrome/login isn't available in this environment,
   verify as deep as the environment allows, and record exactly what could not be
   exercised live in the ledger and final message.
3. Anything not green: classify it (Blocker Protocol), fix through the executor,
   re-run the failed verification. Loop until the harish verification is green.
   Green here is the Definition of Done for the implementation.

## PHASE 6 — SHIP

This prompt is my explicit request to raise the PR. Push the branch
(`git push -u origin <branch>`, retry on network errors with backoff), open a PR
against `main` with a body covering: feature summary, blueprint highlights, test
+ verification evidence, and the decision ledger's crucial entries. Then
`subscribe_pr_activity` and drive CI to green: diagnose and push fixes for every
red check per the drive-to-green rules; never skip or quarantine a test to get
green. Schedule `send_later` check-ins (~1h) until CI is green so a missed
webhook can't strand the PR.

## NOTIFY ME

When CI is green on the PR, message me on the available channel — Gmail to
harishamudha@gmail.com (subject: `[job-bunny] <feature> — PR ready, CI green`)
and a PushNotification if available. Include: PR link, one-paragraph outcome,
the decision ledger, deferred items, and anything that could not be live-verified.
Also message me (same channels) if you stop on a hard blocker.

## BLOCKER PROTOCOL

Classify every blocker the moment you hit it:

1. **Caused by our changes** → must-fix. Do not proceed, do not defer, do not
   work around it. Fix and re-verify.
2. **Not in scope, but blocking the work** (pre-existing bug, broken tooling,
   red base) → attempt a minimal fix in a separate, clearly-labeled commit; note
   it in the ledger. If the minimal fix would be large or risky, treat as (4).
3. **Not blocking progress** → defer. Note it in the ledger and in the final
   message; never fix-creep into it, never silently drop it.
4. **Hard blocker** — blocks the Definition of Done and you cannot fix it
   (missing credential, environment limitation, a fix that would violate the
   stability principle) → stop, commit and push what's green so far, and message
   me with: the classification, what you tried, and 2–3 options with your
   recommendation.

## DECISION LEDGER

Keep a running ledger (a scratch file is fine; its final form ships in the PR
body and the notification). Record **only crucial in-flight judgements**: scope
cuts, PM/UI/BE question answers that shaped the feature, architecture and
placement choices with real trade-offs, blocker classifications, deferrals, and
anything I'd plausibly have decided differently. Do not record atomic or
mechanical decisions — a bloated ledger is as useless as an empty one.
