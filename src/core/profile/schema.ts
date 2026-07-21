import { z } from 'zod';

/**
 * Profile shapes (spec §6). resume.json is the hand-maintained source of
 * truth — PDF parsing is a one-time setup seed, never in the daily path.
 * Skill classification (primary/secondary) is produced by `profile build`
 * and seeds filter skills.core and rank weights: seeding fills gaps,
 * never clobbers user-tuned values.
 */

export const ExperienceSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  years: z.number().positive().optional(),
});

export const ResumeSchema = z.object({
  name: z.string().min(1),
  headline: z.string().optional(),
  skills: z.array(z.string().min(1)).min(1),
  experience: z.array(ExperienceSchema).default([]),
});

export const SkillClassificationSchema = z.object({
  primary: z.array(z.string().min(1)),
  secondary: z.array(z.string().min(1)),
});

export type Resume = z.infer<typeof ResumeSchema>;
export type SkillClassification = z.infer<typeof SkillClassificationSchema>;
