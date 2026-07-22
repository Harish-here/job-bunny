import type { JD, SourcedJD } from '../../core/jd/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Pre-LLM compression stage (P6 spec §6, task 2): reads sourced JDs off the
 * payload, builds the compact markdown table + id-keyed passthrough map
 * (v0's compress.js shape, ported — token efficiency is a design constraint
 * per CLAUDE.md), and persists both to ctx.storage for the structure stage
 * (table) and the assemble stage (passthrough) to read back. The payload
 * itself is threaded through unchanged — `structured` is not added until
 * assemble parses the LLM's decisions.
 *
 * Run-scoped side files (overwritten every run, not accumulated across
 * runs like the company registry): the Storage port is JSON-only, so the
 * markdown table is stored as a JSON string rather than a raw .md file.
 */
export const TABLE_PATH = 'structure/table.json';
export const PASSTHROUGH_PATH = 'structure/passthrough.json';

/**
 * v0 (scripts/pipeline/compress.js) capped rawText at 700 chars for its
 * table slice; v2's StructuredSchema extracts more fields (salary/domain/
 * func) than v0 did, so it needs more source context. Consolidated here
 * (P6 plan note on the source stage: rawText is NOT truncated per-lane —
 * this is the one place it happens) at 2500 chars.
 */
export const RAW_TEXT_TRUNCATE_LENGTH = 2500;

const TABLE_HEADER = '| id | title | company | rawText |\n|---|---|---|---|';

const escapePipe = (value: string): string => value.replace(/\|/g, '｜');

/** Ports v0's sanitiseRawText shape: strip the "about the job" boilerplate
 * header, collapse newlines to a single space, escape `|` for the
 * markdown table, trim, then truncate to RAW_TEXT_TRUNCATE_LENGTH. */
function sanitiseRawText(raw: string): string {
  return raw
    .replace(/^about the job\s*/i, '')
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '｜')
    .trim()
    .slice(0, RAW_TEXT_TRUNCATE_LENGTH);
}

/**
 * Builds the compact markdown table (one row per job: id | title | company
 * | rawText) plus the id-keyed passthrough map (the full JD, for assemble
 * to rejoin against the LLM's decisions). A job without `content.rawText`
 * fails loud — compress must run after the source/farming lanes, so a
 * missing content is a pipeline-ordering bug, not recoverable data.
 */
export function toTable(jobs: SourcedJD[]): {
  table: string;
  passthrough: Record<string, JD>;
} {
  const passthrough: Record<string, JD> = {};
  const rows: string[] = [];

  for (const job of jobs) {
    const rawText = job.content?.rawText;
    if (!rawText) {
      throw new Error(
        `compress: job ${job.identity.id} has no content.rawText — compress must run after the source/farming lanes`,
      );
    }

    const { id, title, company } = job.identity;
    rows.push(
      `| ${id} | ${escapePipe(title)} | ${escapePipe(company)} | ${sanitiseRawText(rawText)} |`,
    );
    passthrough[id] = job;
  }

  const table = rows.length > 0 ? `${TABLE_HEADER}\n${rows.join('\n')}` : TABLE_HEADER;
  return { table, passthrough };
}

export const compressStage: StageDef<StagePayload, StagePayload> = {
  name: 'compress',
  timeoutMs: 30_000,
  retries: 0,
  async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
    // StagePayload's jobs are JD[] (content optional); compress requires
    // content to be present — the type-level guarantee lives at SourcedJD,
    // but toTable defensively checks at runtime too, in case a caller
    // hands compress a payload out of pipeline order.
    const { table, passthrough } = toTable(input.jobs as SourcedJD[]);

    await ctx.storage.writeJson(TABLE_PATH, table);
    await ctx.storage.writeJson(PASSTHROUGH_PATH, passthrough);

    return input;
  },
};
