/**
 * Shared raw-page property readers — the single copy of the idiom
 * previously duplicated privately in cache.ts (text/url subset) and
 * archive.ts (all five), needed a third time by migrate_export.ts,
 * which forced this extraction. Strictly read-shaping: no API calls.
 */
export interface RawPropertyValue {
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  url?: string | null;
  select?: { name: string } | null;
  date?: { start: string } | null;
}

export interface RawPage {
  id: string;
  properties?: Record<string, RawPropertyValue | undefined>;
}

function plainText(parts: { plain_text: string }[] | undefined): string {
  return (parts ?? []).map((t) => t.plain_text).join('');
}

export function propText(p: RawPropertyValue | undefined): string {
  if (p?.title) return plainText(p.title);
  if (p?.rich_text) return plainText(p.rich_text);
  return '';
}

export function propUrl(p: RawPropertyValue | undefined): string | null {
  return p?.url ?? null;
}

export function propSelectName(p: RawPropertyValue | undefined): string | null {
  return p?.select?.name ?? null;
}

export function propDateStart(p: RawPropertyValue | undefined): string | null {
  return p?.date?.start ?? null;
}
