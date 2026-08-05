# Persist-to-DB: Advisor Decision Ledger

Running log of in-flight advisor decisions during the unattended 2026-08-05→06 execution of all four phases (user grant: "you can make judgement in flight and make ledger for it"). Newest entries appended at the bottom.

| # | When | Decision | Rationale |
|---|---|---|---|
| L1 | 2026-08-05 | Integration branch named `main-everything-db`, cut from fresh `origin/main`. | User's message had two spellings; took the corrected one. Fresh fetch per the stale-base worktree lesson. |
| L2 | 2026-08-05 | Each phase lands as a PR targeting `main-everything-db`, merged by the advisor when its gates pass (review wave + `npm run check` + live rajni verification). Merge of `main-everything-db` → `main` is deferred to the user after stability. | User instruction: "push all PR to 'main-everything-db'"; landing on main stays a human decision. |
| L3 | 2026-08-05 | All four phases run tonight; Phase 2–4 specs are written just-in-time, informed by the previous landed phase. | User overrode the phase-1-only recommendation; just-in-time spec order preserved within the night. |
| L4 | 2026-08-05 | Live verification = `profiles/rajni/` via the verify skill only; `profiles/harish/` is never touched. | CLAUDE.md hard rule. |
| L5 | 2026-08-05 | CLAUDE.md edits: the three Phase-1 edits are pre-approved verbatim (advisor session). Phase 4's CLAUDE.md changes (incl. the board hard-rule amendment) land only if the user approves the shown text before going offline; otherwise they ship as a proposed-diff file in the Phase 4 PR. | Standing rule: no instruction-file edits without verbatim approval. |
| L6 | 2026-08-05 | All implementation happens in git worktrees; the primary checkout stays on `main` so any daemon-scheduled overnight run executes released code, not half-rewritten runner code. | Pipeline stability principle; daemon status checked at setup. |
| L7 | 2026-08-05 | "maddog" go signal received; Phase 4 CLAUDE.md hard-rule amendment ("board writes only the `tracking` and config tables") approved verbatim — will be applied in Phase 4 doc-sync. | User's departure message. |
| L8 | 2026-08-05 | Final acceptance gate added: real live run of `profiles/harish/` on the fully-merged `main-everything-db`; on failure → analyze (triager) → fix → re-verify until pass. Explicit owner override of the rajni-only default, for this final gate only. | User instruction in the maddog message. |
| L9 | 2026-08-05 | Phase 3 and Phase 4 specs MUST include existing-profile file→DB imports (dedup cache, registries, config documents) so harish's state carries over; without it the final live run would lose dedup state and create duplicates. | Advisor catch triggered by L8. |
| L10 | 2026-08-05 | Before ANY rajni verification run, confirm `profiles/rajni/profile.json` has `connector: "sqlite"` and the Notion mirror off (or restrict to non-sync stages / dry-run): the rajni fixture's profile.json carries the user's REAL Notion dbId. | Memory: local-db-adoption-design. |
