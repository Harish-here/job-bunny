# v2 P6 — LLM Provider + Structure Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.
> **Depends on:** P1 + P3 merged. Independent of P4/P5 (parallel OK — touches neither browser nor lanes).

**Goal:** `claude -p` LLM provider behind `ports/llm.ts`, and the compress → structure → assemble stages that turn raw JD text into `StructuredJD` — preserving v0's token-economy shape (markdown table in, markdown table out).

**Pin at phase start:** the current table columns + prompt contract from `.claude/commands/structure.md` and `scripts/pipeline/compress.js` / `assemble.js` (read, port the *shape*, not the code).

## Global Constraints

- Branch `feat/v2-p6-structure` off `main-v2`. All P1 constraints apply.
- **Token efficiency is a design constraint** (CLAUDE.md hard rule): compact md table both directions; never JSON through the LLM.
- LLM output is untrusted input: assemble zod-parses every row; a malformed row is a `SoftError` (that job dropped with verdict `structure.unparseable`), never a stage failure.
- Chunked calls: `structure` processes the table in batches of 25 rows, checkpointing decisions after each batch via `ctx.storage` so a killed run resumes mid-stage.

## File Structure

```
src/adapters/llm/claude-cli/
  provider.ts + provider.test.ts     ClaudeCliProvider implements LlmProvider
  index.ts
src/pipeline/stages/
  compress.ts + compress.test.ts     StagePayload → md table + passthrough map
  structure.ts + structure.test.ts   md table → decisions md (via LlmProvider)
  assemble.ts + assemble.test.ts     decisions md → StructuredJD[] (zod ingress)
```

---

### Task 1: ClaudeCliProvider

**Interfaces — Produces:** `ClaudeCliProvider implements LlmProvider` (name `'claude-cli'`) — `complete(prompt, {signal})` spawns `claude -p <prompt-via-stdin> --output-format text` with `node:child_process`, kills the child on signal abort, rejects on non-zero exit with stderr in the message. Ctor `({ command = 'claude', timeoutMs = 300_000 })`.

- [ ] Steps: TDD with a stubbed spawn (echo-script standing in for `claude`): happy path returns stdout; abort kills child; non-zero exit rejects with stderr → implement → one live smoke (`complete('Say OK')`) → commit `feat(v2): claude-cli LLM provider`.

### Task 2: compress stage

**Interfaces — Produces:** `compressStage: StageDef<StagePayload, StagePayload>` plus exported helpers `toTable(jobs: SourcedJD[]): { table: string; passthrough: Record<string, JD> }` — one md row per job (columns pinned from v0: id | title | company | location-ish fields from card), rawText truncated to the v0 budget; passthrough keyed by id persisted to `ctx.storage` (`runs` scoped file) for assemble. Jobs without `content` fail loud (pipeline ordering bug, not data).

- [ ] Steps: TDD `toTable` (row shape, escaping `|` in titles, truncation, passthrough completeness) → implement → commit `feat(v2): compress stage — md table + passthrough`.

### Task 3: structure stage

**Interfaces — Produces:** `makeStructureStage(llm: LlmProvider): StageDef<StagePayload, StagePayload>` — builds the instruction prompt (ported contract from `.claude/commands/structure.md`: output ONLY a md table with the decision columns: id | domain | seniority | func | city | country | workType | timezone | skills | salary), sends 25-row batches, accumulates decision rows, checkpoints raw decisions text per batch (`structure_decisions.partial.md`), resumes from checkpoint on rerun. Stage declares `heartbeat: true`, `retries: 1` — a failed batch retries once before failing the stage loudly (whole-stage LLM outage is loud; a bad *row* is soft and handled in assemble).

- [ ] Steps: TDD with fake LlmProvider (batching at 25; checkpoint after each batch; resume skips completed batches; provider error → one retry then loud) → implement → commit `feat(v2): structure stage — batched LLM normalisation`.

### Task 4: assemble stage

**Interfaces — Produces:** `assembleStage: StageDef<StagePayload, StagePayload>` + helper `parseDecisions(md: string): Map<string, unknown>` — parses decision rows, joins passthrough by id, builds candidate `structured` sections, `StructuredSchema` (P1) parses each; parse/validation failure ⇒ `DroppedRecord` with verdict `{ rule: 'structure.unparseable', severity: 'hard', pass: false, detail }`; ids present in passthrough but missing from decisions get the same treatment (detail `'row missing from LLM output'`).

- [ ] Steps: TDD (clean row → StructuredJD; garbage row dropped with verdict; missing row dropped; skills split/normalized; column-count drift detected) → implement → commit `feat(v2): assemble stage — zod ingress on LLM output`.

### Task 5: Path verify + docs

- [ ] Rajni verify: scratch composition compress → structure (live `claude -p`, ~5 fixture jobs) → assemble; confirm `StructuredJD`s validate and dropped/verdict records appear in the payload.
- [ ] Update `main-v2.md` (P6 ✅). PR into `main-v2`.
