/**
 * core/config/search_urls — parse, dedupe, rebuild, and report changes for
 * `search_urls.md` (spec R3/R4/R9/R10). Byte-identical rebuild contract (for
 * already-well-formed input) with `ui/src/features/settings/sections/
 * searchUrls.model.ts`'s `serializeSearchUrlRows` — header, blank-line
 * placement, and page-order rule mirror that file exactly. Scoped to the
 * Settings row editor's save path only, NOT the onboarding wizard's separate
 * `wizard/serialize.ts` format.
 *
 * `adapters/lanes/linkedin/search_urls.ts`'s read-only `parseSearchUrls`
 * hand-rolls the same line grammar independently — `core-is-pure` forbids
 * sharing it directly; this is a deliberate, accepted duplication.
 */
import {
  classifyLinkedInSearchUrl,
  LINKEDIN_SEARCH_URL_LABELS,
  type LinkedInSearchUrlPage,
} from '../../linkedin_url/index.ts';

export interface NormalizeSearchUrlsResult {
  text: string;
  changes: SearchUrlChange[];
  total: number;
}

export interface SearchUrlChange {
  kind: 'refiled' | 'cleaned' | 'merged';
  label: string;
  detail: string;
}

export interface SearchUrlsSaveReport {
  total: number;
  refiled: number;
  cleaned: number;
  merged: number;
  changes: SearchUrlChange[];
}

// Copied verbatim from `searchUrls.model.ts:17-22` — must stay byte-identical.
const SEED_HEADER =
  '# Search URLs\n\n' +
  'Hierarchical: Channel → page → labeled URLs. One page-type = one inventory ' +
  'in `src/adapters/lanes/linkedin/page_inventory/<page>.json`; many URLs may live ' +
  'beneath it.\n' +
  'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`';

export interface ParsedRow {
  label: string;
  url: string;
  originalPage: string | null;
}

// URL group captures `\S+` (not `https?:\/\/\S+`) so a scheme-less/malformed
// URL is captured as a row rather than silently vanishing.
const BULLET_RE = /^[•*-]\s+(.+?)\s+-\s+(\S+)$/;
const HEADING_RE = /^###\s+(.+)$/;
const INVENTORY_COMMENT_RE = /^<!--\s*inventory:/;
const CHANNEL_HEADING = '## linkedin';

interface ParsedDoc {
  rows: ParsedRow[];
  topNotes: string[];
  // Keyed by the ORIGINAL heading text a note appeared under (insertion order
  // preserved) — B11: re-filed bullets move to their reclassified section, but a
  // note stays put; it was never "attached" to any one bullet.
  sectionNotes: Map<string, string[]>;
}

// The header is regenerated unconditionally by `serialize()` (like the channel
// heading, page headings, and inventory comments below) — so it must be matched
// POSITIONALLY, not by exact text equality against the current SEED_HEADER
// constant. A stored doc predating a header wording change (e.g. an old
// `.md`-suffixed page_inventory reference where the current constant says
// `.json`) would otherwise fail the equality check, fall through into
// `topNotes`, and get preserved verbatim ALONGSIDE the freshly-regenerated
// header — duplicating it. Consuming exactly as many leading non-blank lines
// as SEED_HEADER itself has, regardless of their content, avoids that.
const HEADER_LINE_COUNT = SEED_HEADER.split('\n').filter((l) => l !== '').length;

// B11: everything that isn't a bullet, a blank line, or a structural line the
// normalizer regenerates itself (the SEED_HEADER block, the `## linkedin` channel
// heading, a `### <page>` heading, or its auto-generated inventory comment) is a
// user note — prose or a commented-out line such as `<!-- • old link -->` — kept
// verbatim and reattached to the section it was found under.
function parseDoc(md: string): ParsedDoc {
  const rows: ParsedRow[] = [];
  const topNotes: string[] = [];
  const sectionNotes = new Map<string, string[]>();
  let headerLinesRemaining = HEADER_LINE_COUNT;
  let currentSection: string | null = null;
  let seenChannelHeading = false;

  for (const raw of md.split('\n')) {
    const line = raw.trim(); // MUST trim first — bullet/heading rows are indented
    if (line === '') continue; // blank lines are template structure, never a note

    if (!seenChannelHeading) {
      if (line === CHANNEL_HEADING) {
        seenChannelHeading = true;
      } else if (headerLinesRemaining > 0) {
        headerLinesRemaining--; // positional header line — regenerated, never kept
      } else {
        topNotes.push(raw); // ahead of the channel heading, not part of the header
      }
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h?.[1]) {
      currentSection = h[1].trim();
      continue;
    }
    if (INVENTORY_COMMENT_RE.test(line)) continue; // regenerated per-section

    const m = BULLET_RE.exec(line);
    if (m?.[1] && m?.[2]) {
      rows.push({ label: m[1].trim(), url: m[2].trim(), originalPage: currentSection });
      continue;
    }

    if (currentSection === null) {
      topNotes.push(raw);
    } else {
      const notes = sectionNotes.get(currentSection) ?? [];
      notes.push(raw);
      sectionNotes.set(currentSection, notes);
    }
  }

  return { rows, topNotes, sectionNotes };
}

export function parseRows(md: string): ParsedRow[] {
  return parseDoc(md).rows;
}

// Also covers "label present, URL empty" — both are the same underlying shape:
// text ending in a bare "-" with nothing (or only whitespace) after it.
const INCOMPLETE_BULLET_RE = /^[•*-]\s+.*-\s*$/;

function assertNoUnparsedBulletLine(md: string): void {
  const hasUnparsedBulletLine = md.split('\n').some((raw) => {
    const line = raw.trim();
    if (!/^[•*-]/.test(line)) return false; // not bullet-shaped at all — irrelevant here
    if (BULLET_RE.test(line)) return false; // parsed fine, counted in `rows` already
    return !INCOMPLETE_BULLET_RE.test(line); // real content that still failed to parse
  });
  if (hasUnparsedBulletLine) {
    throw new Error(
      'normalizeSearchUrlsDoc: found a bullet-shaped line that failed to parse — refusing to ' +
        'write (a parse gap would otherwise silently delete a saved link). Nothing written.',
    );
  }
}

function humanLabelOf(page: string | null): string {
  if (page !== null && page in LINKEDIN_SEARCH_URL_LABELS) {
    return LINKEDIN_SEARCH_URL_LABELS[page as LinkedInSearchUrlPage];
  }
  return page ?? 'unfiled';
}

interface ClassifyAndGroupResult {
  order: string[];
  byPage: Map<string, ParsedRow[]>;
  changes: SearchUrlChange[];
}

function classifyAndGroup(rows: ParsedRow[]): ClassifyAndGroupResult {
  const winners = new Map<string, string>(); // dedupe key -> winning label
  const order: string[] = [];
  const byPage = new Map<string, ParsedRow[]>();
  const changes: SearchUrlChange[] = [];

  for (const row of rows) {
    const { page, cleanedUrl, removedParams } = classifyLinkedInSearchUrl(row.url);
    const key = `${page}|${cleanedUrl}`;
    const winningLabel = winners.get(key);
    if (winningLabel !== undefined) {
      changes.push({ kind: 'merged', label: row.label, detail: winningLabel });
      continue;
    }
    winners.set(key, row.label);

    if (removedParams.length > 0) {
      changes.push({
        kind: 'cleaned',
        label: row.label,
        detail: removedParams.join(', '),
      });
    }
    if (row.originalPage !== page) {
      changes.push({
        kind: 'refiled',
        label: row.label,
        detail: `${humanLabelOf(row.originalPage)} → ${LINKEDIN_SEARCH_URL_LABELS[page]}`,
      });
    }

    if (!byPage.has(page)) {
      byPage.set(page, []);
      order.push(page);
    }
    byPage
      .get(page)
      ?.push({ label: row.label, url: cleanedUrl, originalPage: row.originalPage });
  }

  return { order, byPage, changes };
}

interface OutputSection {
  heading: string;
  rows: ParsedRow[];
  notes: string[];
  knownPage: boolean;
}

// B11: a section whose bullets all got re-filed elsewhere (or that never had any)
// can still carry notes the user wrote under it — those are never dropped, even
// though the re-filed bullets themselves don't carry the note along.
function buildSections(
  order: string[],
  byPage: Map<string, ParsedRow[]>,
  sectionNotes: Map<string, string[]>,
): OutputSection[] {
  const sections: OutputSection[] = [];
  const consumed = new Set<string>();
  for (const page of order) {
    consumed.add(page);
    sections.push({
      heading: page,
      rows: byPage.get(page) ?? [],
      notes: sectionNotes.get(page) ?? [],
      knownPage: true,
    });
  }
  for (const [heading, notes] of sectionNotes) {
    if (consumed.has(heading)) continue;
    sections.push({
      heading,
      rows: [],
      notes,
      knownPage: heading in LINKEDIN_SEARCH_URL_LABELS,
    });
  }
  return sections;
}

function serialize(topNotes: string[], sections: OutputSection[]): string {
  const lines = [SEED_HEADER, ''];
  for (const note of topNotes) lines.push(note);
  if (topNotes.length > 0) lines.push('');
  lines.push(CHANNEL_HEADING);
  for (const section of sections) {
    lines.push(`### ${section.heading}`);
    if (section.knownPage) {
      lines.push(
        `<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${section.heading}.json -->`,
      );
    }
    lines.push('');
    for (const note of section.notes) lines.push(note);
    for (const row of section.rows) lines.push(`  • ${row.label} - ${row.url}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Reproduces ux-notes.md §10's three literal templates exactly. Used by
 * later save-report/UI consumers so the wording lives in one place. */
export function formatSearchUrlChangeLine(c: SearchUrlChange): string {
  switch (c.kind) {
    case 'refiled':
      return `re-filed ${c.label}: ${c.detail}`;
    case 'cleaned':
      return `cleaned ${c.label}: removed ${c.detail}`;
    case 'merged':
      return `merged ${c.label} into ${c.detail}`;
  }
}

export function buildSearchUrlsSaveReport(
  r: NormalizeSearchUrlsResult,
): SearchUrlsSaveReport {
  let refiled = 0;
  let cleaned = 0;
  let merged = 0;
  for (const c of r.changes) {
    if (c.kind === 'refiled') refiled++;
    else if (c.kind === 'cleaned') cleaned++;
    else merged++;
  }
  return { total: r.total, refiled, cleaned, merged, changes: r.changes };
}

/** Best-effort label resolution for task 15: parses via `parseRows`,
 * classifies each row's URL, skipping any that fail to classify. Keyed by
 * `cleanedUrl -> label`, first occurrence wins (same dedupe rule as the
 * rebuild path). Never throws. */
export function resolveSearchUrlLabels(rawMarkdown: string): Map<string, string> {
  const rows = parseRows(rawMarkdown);
  const labels = new Map<string, string>();
  for (const row of rows) {
    let cleanedUrl: string;
    try {
      ({ cleanedUrl } = classifyLinkedInSearchUrl(row.url));
    } catch {
      continue;
    }
    if (!labels.has(cleanedUrl)) labels.set(cleanedUrl, row.label);
  }
  return labels;
}

export function normalizeSearchUrlsDoc(rawText: string): NormalizeSearchUrlsResult {
  assertNoUnparsedBulletLine(rawText);
  const { rows, topNotes, sectionNotes } = parseDoc(rawText);
  const { order, byPage, changes } = classifyAndGroup(rows);
  const sections = buildSections(order, byPage, sectionNotes);
  const text = serialize(topNotes, sections);
  let total = 0;
  for (const pageRows of byPage.values()) total += pageRows.length;
  return { text, changes, total };
}
