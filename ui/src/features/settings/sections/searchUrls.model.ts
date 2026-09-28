/** Pure parse/serialize pair for search_urls.md, mirroring the grammar
 * src/adapters/lanes/linkedin/search_urls.ts's parseSearchUrls uses at run
 * time. No I/O — SearchUrlsSection owns reading/writing via configDocQuery
 * and useConfigMutation directly (see task-10-brief's Global constraints). */
export interface SearchUrlRow {
  page: string;
  label: string;
  url: string;
  touched: boolean;
}

const COVERED_PAGES = new Set(['linkedin__jobs-search', 'linkedin__jobs-search-results']);

export function isPageCovered(page: string): boolean {
  return COVERED_PAGES.has(page);
}

const SEED_HEADER =
  '# Search URLs\n\n' +
  'Hierarchical: Channel → page → labeled URLs. One page-type = one inventory ' +
  'in `src/adapters/lanes/linkedin/page_inventory/<page>.json`; many URLs may live ' +
  'beneath it.\n' +
  'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`';

export function parseSearchUrlRows(text: string): SearchUrlRow[] {
  const rows: SearchUrlRow[] = [];
  let currentPage: string | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const pageMatch = line.match(/^###\s+(.+)$/);
    if (pageMatch?.[1]) {
      currentPage = pageMatch[1].trim();
      continue;
    }
    if (currentPage === null) continue;
    const bulletMatch = line.match(/^[•*-]\s+(.+?)\s+-\s+(\S+)$/);
    if (bulletMatch?.[1] && bulletMatch[2]) {
      rows.push({
        page: currentPage,
        label: bulletMatch[1].trim(),
        url: bulletMatch[2].trim(),
        touched: true,
      });
    }
  }
  return rows;
}

export function serializeSearchUrlRows(rows: SearchUrlRow[]): string {
  const order: string[] = [];
  const byPage = new Map<string, SearchUrlRow[]>();
  for (const row of rows) {
    if (!byPage.has(row.page)) {
      byPage.set(row.page, []);
      order.push(row.page);
    }
    byPage.get(row.page)?.push(row);
  }

  const lines = [SEED_HEADER, '', '## linkedin'];
  for (const page of order) {
    lines.push(`### ${page}`);
    lines.push(
      `<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${page}.json -->`,
    );
    lines.push('');
    for (const row of byPage.get(page) ?? []) {
      lines.push(`  • ${row.label} - ${row.url}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
