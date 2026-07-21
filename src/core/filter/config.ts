import { z } from 'zod';
import { WorkTypeSchema } from '../jd/index.ts';

/** Filter config (spec §6): values live in profiles/<p>/filter.json —
 * this module owns only the shape and defaults. Severity is per-rule:
 * hard ⇒ drop (recorded), soft ⇒ keep + rank penalty. */

export const SeveritySchema = z.enum(['hard', 'soft']);

export const MatchRuleSchema = z.object({
  match: z.array(z.string().min(1)).default([]),
  reject: z.array(z.string().min(1)).default([]),
  severity: SeveritySchema.default('hard'),
});

export const FilterConfigSchema = z.object({
  title: z
    .object({
      domain: MatchRuleSchema.optional(),
      function: MatchRuleSchema.optional(),
      seniority: MatchRuleSchema.optional(),
    })
    .optional(),
  companies: z.object({ avoid: z.array(z.string().min(1)) }).optional(),
  locations: z
    .array(
      z.object({
        city: z.string().min(1),
        country: z.string().optional(),
        workTypes: z.array(WorkTypeSchema).min(1),
      }),
    )
    .optional(),
  timezones: z
    .object({ accept: z.array(z.string().min(1)), severity: SeveritySchema.default('hard') })
    .optional(),
  skills: z
    .object({
      core: z.array(z.string().min(1)),
      minMatch: z.number().int().min(1).default(1),
      severity: SeveritySchema.default('hard'),
    })
    .optional(),
});

export type FilterConfig = z.infer<typeof FilterConfigSchema>;
