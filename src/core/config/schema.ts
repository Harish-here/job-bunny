import { z } from 'zod';

/**
 * Per-profile pipeline config (spec §3): core owns WHAT is enabled;
 * adapters own their own settings shape, validated at wire time
 * (cli/wire.ts is the single composition point). Config is the wiring —
 * nothing else decides which adapters run.
 */

export const ScheduleSchema = z.object({
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
});

export const PipelineConfigSchema = z.object({
  lanes: z.array(z.string().min(1)).default([]),
  connector: z.string().min(1),
  notifiers: z.array(z.string().min(1)).default([]),
  routines: z.array(z.string().min(1)).default([]),
  schedule: ScheduleSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
