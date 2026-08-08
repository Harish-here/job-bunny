/** Pure parse/serialize pair for search_urls.md, mirroring the grammar
 * src/adapters/lanes/linkedin/search_urls.ts's parseSearchUrls uses at run
 * time. No I/O — SearchUrlsSection owns reading/writing via configDocQuery
 * and useConfigMutation directly (see task-10-brief's Global constraints). */
export interface SearchUrlRow {
  slug: string;
  label: string;
  url: string;
}

const COVERED_SLUGS = new Set(['linkedin__jobs-search', 'linkedin__jobs-search-results']);

export function isSlugCovered(slug: string): boolean {
  return COVERED_SLUGS.has(slug);
}

const SEED_HEADER =
  '# Search URLs\n\n' +
  'Hierarchical: Channel → page → labeled URLs. One page-type = one inventory ' +
  'in `src/adapters/lanes/linkedin/page_inventory/<page>.json`; many URLs may live ' +
  'beneath it.\n' +
  'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`';

export function parseSearchUrlRows(text: string): SearchUrlRow[] {
  const rows: SearchUrlRow[] = [];
  let currentSlug: string | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const slugMatch = line.match(/^###\s+(.+)$/);
    if (slugMatch?.[1]) {
      currentSlug = slugMatch[1].trim();
      continue;
    }
    if (currentSlug === null) continue;
    const bulletMatch = line.match(/^[•*-]\s+(.+?)\s+-\s+(\S+)$/);
    if (bulletMatch?.[1] && bulletMatch[2]) {
      rows.push({
        slug: currentSlug,
        label: bulletMatch[1].trim(),
        url: bulletMatch[2].trim(),
      });
    }
  }
  return rows;
}

export function serializeSearchUrlRows(rows: SearchUrlRow[]): string {
  const order: string[] = [];
  const bySlug = new Map<string, SearchUrlRow[]>();
  for (const row of rows) {
    if (!bySlug.has(row.slug)) {
      bySlug.set(row.slug, []);
      order.push(row.slug);
    }
    bySlug.get(row.slug)?.push(row);
  }

  const lines = [SEED_HEADER, '', '## linkedin'];
  for (const slug of order) {
    lines.push(`### ${slug}`);
    lines.push(
      `<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${slug}.json -->`,
    );
    lines.push('');
    for (const row of bySlug.get(slug) ?? []) {
      lines.push(`  • ${row.label} - ${row.url}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
