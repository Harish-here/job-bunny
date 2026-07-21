import { z } from 'zod';
import type { DoctorCheck, DoctorFinding, Storage } from '../../../ports/index.ts';

/**
 * v2 page-inventory schema (spec: DOM drift is fixed by regenerating the
 * inventory via /page-analyse, never by editing lane code). Inventories are
 * machine-shared JSON at repo root `page_inventory/<page>.json`.
 */
export const InventorySchema = z.object({
  page: z.string(),
  pageType: z.enum(['details-page', 'popup']),
  generatedAt: z.iso.date(),
  selectors: z.object({
    cardList: z.string(),
    card: z.string(),
    cardTitle: z.string(),
    cardCompany: z.string(),
    cardLocation: z.string(),
    cardLink: z.string(),
    jdRoot: z.string(),
    pagination: z.string().optional(),
  }),
  behaviors: z.record(z.string(), z.string()).default({}),
});

export type Inventory = z.infer<typeof InventorySchema>;

export function inventoryPath(page: string): string {
  return `page_inventory/${page}.json`;
}

/** Loud on a missing inventory — the caller asked for this page; the
 * doctor-level freshness check is what surfaces this as a soft 'red'
 * before a run starts. */
export async function loadInventory(storage: Storage, page: string): Promise<Inventory> {
  const inventory = await storage.readJson(inventoryPath(page), InventorySchema);
  if (!inventory) {
    throw new Error(
      `missing page inventory for "${page}" (expected ${inventoryPath(page)})`,
    );
  }
  return inventory;
}

function ageInDays(generatedAt: string, now: Date): number {
  const generated = new Date(`${generatedAt}T00:00:00.000Z`);
  return (now.getTime() - generated.getTime()) / (1000 * 60 * 60 * 24);
}

/** DoctorCheck: missing inventory for any requested page ⇒ red; present
 * but generatedAt older than maxAgeDays ⇒ warn; all present and fresh ⇒ ok. */
export function inventoryFreshnessCheck(
  storage: Storage,
  pages: string[],
  maxAgeDays: number,
): DoctorCheck {
  const name = 'linkedin-inventory-freshness';
  return {
    name,
    async run(): Promise<DoctorFinding> {
      const missing: string[] = [];
      const stale: string[] = [];
      const now = new Date();
      for (const page of pages) {
        const inventory = await storage.readJson(inventoryPath(page), InventorySchema);
        if (!inventory) {
          missing.push(page);
          continue;
        }
        if (ageInDays(inventory.generatedAt, now) > maxAgeDays) {
          stale.push(page);
        }
      }
      if (missing.length > 0) {
        const staleNote =
          stale.length > 0 ? `; stale (>${maxAgeDays}d): ${stale.join(', ')}` : '';
        return {
          check: name,
          status: 'red',
          detail: `missing inventory for: ${missing.join(', ')}${staleNote}`,
        };
      }
      if (stale.length > 0) {
        return {
          check: name,
          status: 'warn',
          detail: `stale inventory (>${maxAgeDays}d old): ${stale.join(', ')}`,
        };
      }
      return {
        check: name,
        status: 'ok',
        detail: `all ${pages.length} page inventories present and fresh (<=${maxAgeDays}d)`,
      };
    },
  };
}
