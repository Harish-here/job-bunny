/**
 * The human tracking-field shape (local-DB spec §3's `tracking` zone):
 * the manual Notion columns' local home. Owned/edited by the board app
 * (PR 4); written in bulk exactly once by `jobbunny migrate` (PR 2),
 * insert-only — an existing row always wins.
 * All fields optional — a job with no human tracking has no row at all.
 */
import { z } from 'zod';
import type { JD } from '../jd/index.ts';

export const TrackingFieldsSchema = z.object({
  status: z.string().min(1).optional(),
  compRange: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  contact: z.string().min(1).optional(),
  dateApplied: z.iso.date().optional(),
  nextAction: z.string().min(1).optional(),
  nextActionDate: z.iso.date().optional(),
});

export type TrackingFields = z.infer<typeof TrackingFieldsSchema>;

/** One Notion page, translated for import: the synthesized JD plus the
 * manual tracking fields (absent when the page had none). */
export interface MigratedRecord {
  jd: JD;
  tracking?: TrackingFields;
}
