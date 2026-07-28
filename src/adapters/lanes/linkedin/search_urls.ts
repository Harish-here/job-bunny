export interface SearchUrlGroup {
  page: string;
  urls: string[];
}

/**
 * Parses `search_urls.md`'s hierarchical Channel -> page -> labeled-URLs
 * format (v0 format unchanged, scripts/pipeline/extract/parse.js). Each
 * `### <page>` heading starts a group named `<page>` (the `<!-- inventory:
 * ... -->` comment beneath it is v0-only path plumbing — v2 resolves the
 * Inventory for a group by matching `page` against the lane's own
 * `inventories` array instead, so the comment is ignored here); each
 * `  • <label> - <url>` line beneath it is appended to that group. `##`
 * channel headings are structural only and don't affect grouping. Groups
 * with zero URLs are dropped.
 */
export function parseSearchUrls(md: string): SearchUrlGroup[] {
  const groups = new Map<string, string[]>();
  let currentPage: string | null = null;

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const pageMatch = line.match(/^###\s+(.+)$/);
    if (pageMatch?.[1]) {
      currentPage = pageMatch[1].trim();
      if (!groups.has(currentPage)) groups.set(currentPage, []);
      continue;
    }
    if (!currentPage) continue;
    const urlMatch = line.match(/^[•*-]\s+.+?\s+-\s+(https?:\/\/\S+)$/);
    if (urlMatch?.[1]) {
      groups.get(currentPage)?.push(urlMatch[1].trim());
    }
  }

  return [...groups.entries()]
    .map(([page, urls]) => ({ page, urls }))
    .filter((group) => group.urls.length > 0);
}
