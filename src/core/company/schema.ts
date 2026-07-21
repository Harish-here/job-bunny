import { z } from 'zod';

/**
 * Company registry (spec §5, P5): a per-profile ledger of every company
 * seen by any lane, plus per-api-lane probe/board state. Registry state
 * lives at profiles/<p>/data/registry/companies.json via Storage — this
 * module owns only shape and defaults; core/company itself is pure
 * (state in, state out — see registry.ts).
 */

export const ProbeStateSchema = z.object({
  status: z.enum(['unprobed', 'found', 'not-found', 'error', 'stale']),
  boardRef: z.string().optional(),
  probedAt: z.iso.datetime().optional(),
  failCount: z.number().int().min(0).default(0),
});

export const CompanyRecordSchema = z.object({
  name: z.string().min(1),
  normalizedKey: z.string().min(1), // via P1 companyKey
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  seenBy: z.array(z.string()),
  probes: z.record(z.string(), ProbeStateSchema).default({}), // key = api lane name
  curated: z.boolean().default(false),
});

export const RegistrySchema = z.array(CompanyRecordSchema);

export type ProbeState = z.infer<typeof ProbeStateSchema>;
export type CompanyRecord = z.infer<typeof CompanyRecordSchema>;

/**
 * Plain interface, not a schema — callers (pipeline stage / wire.ts) pass
 * concrete values; defaults documented here are not enforced by this module.
 * Defaults: reprobeNotFoundAfterDays = 30, maxProbeFailures = 3,
 * staleAfterFetchFailures = 3.
 */
export interface RegistryPolicy {
  reprobeNotFoundAfterDays: number;
  maxProbeFailures: number;
  staleAfterFetchFailures: number;
}
