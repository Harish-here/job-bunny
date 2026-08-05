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
