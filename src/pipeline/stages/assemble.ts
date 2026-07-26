import { z } from 'zod';
import {
  type DroppedRecord,
  type JD,
  JDSchema,
  type StructuredJD,
  StructuredSchema,
  type WorkType,
} from '../../core/jd/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';
import { PASSTHROUGH_PATH } from './compress.ts';
import { DECISIONS_PATH } from './structure.ts';

/**
 * Assemble stage (P6 spec §6, task 4): the zod INGRESS BOUNDARY on untrusted
 * LLM output. Reads compress's passthrough map (Record<id, JD> — the
 * authoritative job set, since compress saw every job that reached
 * structure) and structure's decisions markdown table, joins them by id,
 * builds a candidate `structured` section per row from the 10-column
 * decisions schema (id | domain | seniority | func | city | country |
 * workType | timezone | skills | salary), and zod-validates it against
 * StructuredSchema (P1). A row that fails to join, fails column-count
 * sanity, or fails schema validation is never a thrown stage failure — it
 * becomes a DroppedRecord (rule 'structure.unparseable', severity 'hard')
 * so the funnel can always answer "why did this job disappear?" (fail-soft
 * per-row; fail-loud only for missing input files, a pipeline-ordering
 * bug).
 */

const PassthroughSchema = z.record(z.string(), JDSchema);

/** True when `line` (already known to start with `|`) is a markdown table
 * separator row (`|---|---|`, optional `:` alignment markers) rather than a
 * data row — mirrors structure.ts's isSeparatorLine (kept local: it's a
 * three-line predicate, not worth sharing across the storage boundary). */
function isSeparatorLine(line: string): boolean {
  return line.replace(/[|:\-\s]/g, '').length === 0;
}

/** Splits a markdown table row into its cell values, trimmed, dropping the
 * (empty) leading/trailing entries produced by the row's own bounding `|`
 * characters — NOT coercing to any fixed column count, so a row with the
 * wrong number of columns (drift) is still detectable downstream via
 * `cells.length`. */
function splitRow(line: string): string[] {
  const parts = line.split('|');
  if (parts.length > 0 && parts[0]?.trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1]?.trim() === '') parts.pop();
  return parts.map((cell) => cell.trim());
}

/**
 * Parses the structure stage's decisions markdown table into a map keyed by
 * row id. Each value is the row's raw cell array (id + 9 fields, in column
 * order) — deliberately untransformed (`unknown` per the signature) so
 * column-count drift is preserved as `cells.length` rather than silently
 * coerced by a fixed-arity destructure here. Header and separator lines are
 * skipped; a row with no usable first cell (empty, or literally "id" —
 * i.e. another header-looking line) is skipped too.
 */
export function parseDecisions(md: string): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (isSeparatorLine(line)) continue;
    const cells = splitRow(line);
    const id = cells[0];
    if (!id || id.toLowerCase() === 'id') continue;
    rows.set(id, cells);
  }
  return rows;
}

const WORK_TYPE_ALIASES: Record<string, WorkType> = {
  onsite: 'onsite',
  'on-site': 'onsite',
  remote: 'remote',
  hybrid: 'hybrid',
};

/** Normalizes a free-text workType cell to the StructuredSchema enum;
 * anything unrecognized (including empty) yields `undefined` — workType is
 * optional, so an unknown value must never sink the whole row. */
function normalizeWorkType(raw: string): WorkType | undefined {
  return WORK_TYPE_ALIASES[raw.trim().toLowerCase()];
}

interface DecisionFields {
  domain: string;
  seniority: string;
  func: string;
  city: string;
  country: string;
  workType: string;
  timezone: string;
  skills: string;
  salary: string;
}

/** Builds the candidate `structured` object from the 9 non-id decision
 * cells, per the task's exact transforms — returns `unknown` since
 * validity is StructuredSchema.safeParse's job, not this function's. */
function buildCandidate(fields: DecisionFields): unknown {
  const domain = fields.domain.trim();
  const seniority = fields.seniority.trim();
  const func = fields.func.trim();
  const city = fields.city.trim();
  const country = fields.country.trim();
  const timezone = fields.timezone.trim();
  const salary = fields.salary.trim();

  return {
    titleParts: {
      domain: domain || undefined,
      seniority: seniority || undefined,
      func: func || undefined,
    },
    locations: city.length > 0 ? [{ city, country: country || undefined }] : [],
    workType: normalizeWorkType(fields.workType),
    timezone: timezone || undefined,
    skills: fields.skills
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    salary: salary || undefined,
  };
}

function unparseableDrop(jd: JD, detail: string): DroppedRecord {
  return {
    jd,
    reasons: [{ rule: 'structure.unparseable', severity: 'hard', pass: false, detail }],
  };
}

const DECISION_COLUMN_COUNT = 10;

export const assembleStage: StageDef<StagePayload, StagePayload> = {
  name: 'assemble',
  timeoutMs: 30_000,
  retries: 0,
  async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
    const passthrough = await ctx.storage.readJson(PASSTHROUGH_PATH, PassthroughSchema);
    if (passthrough === undefined) {
      throw new Error(
        `assemble: no passthrough found at ${PASSTHROUGH_PATH} — assemble must run after compress`,
      );
    }

    const decisionsMd = await ctx.storage.readJson(DECISIONS_PATH, z.string());
    if (decisionsMd === undefined) {
      throw new Error(
        `assemble: no decisions found at ${DECISIONS_PATH} — assemble must run after structure`,
      );
    }

    const decisions = parseDecisions(decisionsMd);

    const jobs: StructuredJD[] = [];
    const newDrops: DroppedRecord[] = [];

    for (const [id, jd] of Object.entries(passthrough)) {
      const row = decisions.get(id);
      if (row === undefined) {
        newDrops.push(unparseableDrop(jd, 'row missing from LLM output'));
        continue;
      }

      const cells = row as string[];
      if (cells.length !== DECISION_COLUMN_COUNT) {
        newDrops.push(
          unparseableDrop(
            jd,
            `expected ${DECISION_COLUMN_COUNT} columns, got ${cells.length}`,
          ),
        );
        continue;
      }

      const [
        ,
        domain,
        seniority,
        func,
        city,
        country,
        workType,
        timezone,
        skills,
        salary,
      ] = cells as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const candidate = buildCandidate({
        domain,
        seniority,
        func,
        city,
        country,
        workType,
        timezone,
        skills,
        salary,
      });

      const parsed = StructuredSchema.safeParse(candidate);
      if (!parsed.success) {
        newDrops.push(unparseableDrop(jd, parsed.error.message));
        continue;
      }

      jobs.push({ ...jd, structured: parsed.data });
    }

    return { jobs, dropped: [...input.dropped, ...newDrops] };
  },
};
