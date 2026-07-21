import { z } from 'zod';

/**
 * The universal JD (spec §4): the only definition of a job in the
 * codebase. One record, filled progressively —
 * identity (lane) → content (fetch) → structured (LLM) →
 * evaluation (filter/dedup/rank) → sync (connector).
 * zod re-validates only at ingress boundaries (lane output, LLM output,
 * connector reads); internal stage handoffs trust these types.
 */

export const WorkTypeSchema = z.enum(['onsite', 'hybrid', 'remote']);

export const IdentitySchema = z.object({
  id: z.string().min(1),
  lane: z.string().min(1),
  url: z.url(),
  company: z.string().min(1),
  title: z.string().min(1),
  postedAt: z.iso.date().optional(),
  scrapedAt: z.iso.datetime(),
});

export const ContentSchema = z.object({
  rawText: z.string().min(1),
});

export const TitlePartsSchema = z.object({
  domain: z.string().optional(),
  seniority: z.string().optional(),
  func: z.string().optional(),
});

export const LocationSchema = z.object({
  city: z.string().min(1),
  country: z.string().optional(),
});

export const StructuredSchema = z.object({
  titleParts: TitlePartsSchema,
  locations: z.array(LocationSchema),
  workType: WorkTypeSchema.optional(),
  timezone: z.string().optional(),
  skills: z.array(z.string()),
  salary: z.string().optional(),
});

export const VerdictSchema = z.object({
  rule: z.string().min(1),
  severity: z.enum(['hard', 'soft']),
  pass: z.boolean(),
  detail: z.string().optional(),
});

export const EvaluationSchema = z.object({
  verdicts: z.array(VerdictSchema),
  duplicateOf: z.string().optional(),
  score: z.number().min(0).max(100).optional(),
  excitement: z.string().optional(),
  matchReasons: z.array(z.string()).default([]),
});

export const SyncStateSchema = z.object({
  pageId: z.string().min(1),
  syncedAt: z.iso.datetime(),
});

export const JDSchema = z.object({
  identity: IdentitySchema,
  content: ContentSchema.optional(),
  structured: StructuredSchema.optional(),
  evaluation: EvaluationSchema.optional(),
  sync: SyncStateSchema.optional(),
});

export type WorkType = z.infer<typeof WorkTypeSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type JD = z.infer<typeof JDSchema>;

/** Canonical shape for a card or JD that failed a filter gate, paired with
 * the verdicts that explain why — shared by every gate (card-gate in the
 * farming lanes, the structured-JD filter stage) so the funnel and
 * checkpoints can always answer "why did this job disappear?" (spec §4).
 * Single definition: gates must import this rather than redeclare it. */
export interface DroppedRecord {
  jd: JD;
  reasons: Verdict[];
}

/** Staged shapes — stage signatures require their inputs at compile time. */
export type SourcedJD = JD & { content: z.infer<typeof ContentSchema> };
export type StructuredJD = JD & { structured: z.infer<typeof StructuredSchema> };
export type EvaluatedJD = StructuredJD & {
  evaluation: z.infer<typeof EvaluationSchema>;
};
export type SyncedJD = JD & { sync: z.infer<typeof SyncStateSchema> };
