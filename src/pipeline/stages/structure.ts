import { z } from 'zod';
import type { LlmProvider } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';
import { TABLE_PATH } from './compress.ts';

/**
 * LLM normalisation stage (P6 spec §6, task 3): reads the compact markdown
 * table compress.ts wrote, sends it to the LLM in batches, and accumulates
 * a *decisions* markdown table (id | domain | seniority | func | city |
 * country | workType | timezone | skills | salary — aligned to
 * StructuredSchema's titleParts/locations/workType/timezone/skills/salary)
 * for the assemble stage (Task 4) to zod-parse per row.
 *
 * Run-scoped side files, JSON-wrapped strings (the Storage port is
 * JSON-only — see compress.ts's header note; there is no separate .md
 * write mechanism, so "structure_decisions.partial.md" in the plan names
 * the CONTENT, not a literal file).
 */
export const DECISIONS_PARTIAL_PATH = 'structure/decisions.partial.json';
export const DECISIONS_PATH = 'structure/decisions.json';

/** Rows sent to the LLM per call. Ported from v0's checkpoint-every-25-rows
 * cadence (`.claude/commands/structure.md`); also the checkpoint cadence
 * here — one storage write per batch. */
export const BATCH_SIZE = 25;

/**
 * Per-attempt ceiling for the WHOLE stage (every batch, not one LLM call).
 * Sized against ClaudeCliProvider's own per-call default (300_000ms):
 * a run with several hundred queued jobs can need a couple dozen batches,
 * so the stage timeout is set generously above what even a slow multi-batch
 * run should need, while still being a real ceiling (not Infinity) so a
 * wedged provider can't hang the run forever. If job volume per run grows
 * enough to threaten this, raise it (or lower BATCH_SIZE) rather than
 * removing the ceiling.
 */
const TIMEOUT_MS = 1_800_000;

const DECISIONS_HEADER =
  '| id | domain | seniority | func | city | country | workType | timezone | skills | salary |';
const DECISIONS_SEPARATOR = '|---|---|---|---|---|---|---|---|---|---|';

interface TableRow {
  id: string;
  /** The full markdown row line, verbatim (including its own `| id | ... |`
   * cells) — carried through unparsed; only the id is pulled out, for
   * resume-skip and prompt-batching. */
  raw: string;
}

/** True when `line` (already known to start with `|`) is a markdown table
 * separator row (`|---|---|`, with optional `:` alignment markers) rather
 * than a data row — i.e. stripping `|`, `-`, `:`, and whitespace leaves
 * nothing. */
function isSeparatorLine(line: string): boolean {
  return line.replace(/[|:\-\s]/g, '').length === 0;
}

function firstCell(line: string): string {
  const cells = line.split('|');
  // cells[0] is the (empty) text before the leading '|'; cells[1] is the
  // first real column.
  return (cells[1] ?? '').trim();
}

/**
 * Pulls data rows (id + verbatim line) out of an arbitrary markdown table
 * string, tolerant of what actually precedes them: skips separator lines
 * and any header-looking line (first cell literally "id") wherever they
 * appear, rather than assuming a fixed header/separator position. This one
 * function parses the compress-produced input table, our own
 * accumulated/partial decisions tables, AND the LLM's raw batch responses
 * (which the prompt asks to be header+separator+rows, but a model that
 * emits only data rows — or stray prose lines that don't start with `|` —
 * is still handled correctly).
 */
function extractRows(markdown: string): TableRow[] {
  const rows: TableRow[] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (isSeparatorLine(line)) continue;
    const id = firstCell(line);
    if (!id || id.toLowerCase() === 'id') continue;
    rows.push({ id, raw: line });
  }
  return rows;
}

function buildDecisionsTable(rows: TableRow[]): string {
  const body = rows.map((r) => r.raw).join('\n');
  return body.length > 0
    ? `${DECISIONS_HEADER}\n${DECISIONS_SEPARATOR}\n${body}`
    : `${DECISIONS_HEADER}\n${DECISIONS_SEPARATOR}`;
}

/** Ports the STYLE (not the column set) of `.claude/commands/structure.md`:
 * output ONLY the table, normalize skill synonyms, escape literal `|`,
 * timezone only for remote roles. Column set is P6/task-3's own
 * (advisor-pinned), aligned to StructuredSchema. */
function buildPrompt(inputHeaderLine: string, batch: TableRow[]): string {
  return [
    'You are structuring job postings into normalized fields for a job-search pipeline.',
    '',
    'Input: a markdown table of job postings, one row per posting.',
    inputHeaderLine,
    ...batch.map((r) => r.raw),
    '',
    'For each input row, output EXACTLY one row of a markdown table with these columns, in this exact order — and output ONLY that table, nothing else (no prose, no explanation, no extra commentary):',
    DECISIONS_HEADER,
    '',
    'Column rules:',
    '- id: copy the input id exactly, unchanged.',
    '- domain: the broad domain/space of the role (e.g. "Frontend", "Backend", "Data", "ML", "DevOps"); empty if unclear.',
    '- seniority: free-text seniority level (e.g. Staff, Lead, Mid, Manager, Senior); empty if unclear.',
    '- func: the specific function/discipline within the domain (e.g. "React", "Platform Engineering", "Growth"); empty if unclear.',
    '- city: the city the role is based in, derived from the title/company/rawText; empty if unknown.',
    '- country: the country the role is based in; empty if unknown.',
    '- workType: one of "onsite", "hybrid", "remote"; empty if unclear.',
    '- timezone: populate ONLY when workType = remote (e.g. "APAC", "EMEA", "US Pacific"); leave empty otherwise.',
    '- skills: semicolon-separated normalized skill names (e.g. "React; TypeScript; Node.js"); normalize synonyms (e.g. "ReactJS" -> "React").',
    '- salary: the salary/compensation range as stated; empty if not mentioned.',
    '- Escape any literal "|" inside a cell value as "｜" (fullwidth pipe) so the table can never be split incorrectly.',
    '',
    'One output row per input id — do not skip, merge, or reorder rows.',
  ].join('\n');
}

/**
 * Builds the structure stage: batches the compress-produced table to the
 * LLM (BATCH_SIZE rows per call), checkpointing accumulated decisions after
 * every batch so a retried/rerun attempt resumes from the last completed
 * batch instead of re-sending already-decided rows. `retries: 1` is the
 * runner's whole-stage retry (guardStage re-invokes `run()`, see
 * pipeline/runner/guard.ts) — this stage does NOT layer its own retry loop
 * on top: a thrown/rejected `llm.complete` call propagates straight out of
 * `run()` (loud), and the runner's one retry + this stage's checkpoint
 * resume together give "failed batch retries once, then fails the stage
 * loudly" without redundant machinery.
 */
export function makeStructureStage(
  llm: LlmProvider,
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'structure',
    timeoutMs: TIMEOUT_MS,
    retries: 1,
    heartbeat: true,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
      const tableJson = await ctx.storage.readJson(TABLE_PATH, z.string());
      if (tableJson === undefined) {
        throw new Error(
          `structure: no input table found at ${TABLE_PATH} — structure must run after compress`,
        );
      }

      const inputRows = extractRows(tableJson);
      const inputHeaderLine = tableJson.split('\n')[0]?.trim() ?? '';

      const partialJson = await ctx.storage.readJson(DECISIONS_PARTIAL_PATH, z.string());
      const accumulated = partialJson !== undefined ? extractRows(partialJson) : [];
      const doneIds = new Set(accumulated.map((r) => r.id));

      const remaining = inputRows.filter((r) => !doneIds.has(r.id));
      const totalBatches = Math.ceil(remaining.length / BATCH_SIZE);

      ctx.logger.info('structure: starting', {
        totalRows: inputRows.length,
        alreadyDone: accumulated.length,
        remaining: remaining.length,
        totalBatches,
      });

      for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
        const batch = remaining.slice(i, i + BATCH_SIZE);
        const batchIndex = i / BATCH_SIZE + 1;

        ctx.logger.debug('structure: sending batch', {
          batchIndex,
          totalBatches,
          rows: batch.length,
        });

        const prompt = buildPrompt(inputHeaderLine, batch);
        const response = await llm.complete(prompt, { signal: ctx.signal });
        const parsedRows = extractRows(response);

        // The stage's own contract with the assemble stage is "every id sent
        // to the LLM shows up in decisions.json" — assemble is the net that
        // catches a genuinely missing id, but a batch dropping ids at the
        // LLM-response-parsing step here would otherwise be totally silent.
        // Compute what was sent vs. what came back and warn loudly (without
        // changing control flow — assemble remains the source of truth for
        // the drop itself).
        const parsedIds = new Set(parsedRows.map((r) => r.id));
        const missingIds = batch.map((r) => r.id).filter((id) => !parsedIds.has(id));
        if (missingIds.length > 0) {
          ctx.logger.warn('structure: LLM response omitted ids sent in this batch', {
            batchIndex,
            missingCount: missingIds.length,
            missingIds,
          });
        }

        accumulated.push(...parsedRows);
        ctx.beat();
        await ctx.storage.writeJson(
          DECISIONS_PARTIAL_PATH,
          buildDecisionsTable(accumulated),
        );
      }

      const finalTable = buildDecisionsTable(accumulated);
      await ctx.storage.writeJson(DECISIONS_PATH, finalTable);
      // Clear the partial now that decisions.json holds the complete table —
      // optional per the P6 plan, done here so a stale partial from a
      // finished run can never shadow a later run's resume logic.
      await ctx.storage.writeJson(DECISIONS_PARTIAL_PATH, buildDecisionsTable([]));

      ctx.logger.info('structure: done', {
        totalRows: inputRows.length,
        decisions: accumulated.length,
      });

      return input;
    },
  };
}
