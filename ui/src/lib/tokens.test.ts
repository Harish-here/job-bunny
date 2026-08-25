// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXCITEMENT_OPTIONS, STATUS_OPTIONS } from '../../../src/core/tracking/vocab.ts';

const cssPath = fileURLToPath(new URL('../index.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

const referencePath = fileURLToPath(
  new URL('../../../docs/product/ui-design-system/reference.md', import.meta.url),
);
const referenceMd = readFileSync(referencePath, 'utf8');

function extractBlock(selector: string): string {
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`);
  const body = css.match(re)?.[1];
  if (body === undefined) throw new Error(`block not found: ${selector}`);
  return body;
}

const rootBlock = extractBlock(':root');
const darkBlock = extractBlock('\\.dark');
const themeBlock = extractBlock('@theme inline');

const LIGHT: Array<[string, string]> = [
  ['--background', '#faf8fd'],
  ['--foreground', '#3d2c55'],
  ['--card', '#ffffff'],
  ['--card-foreground', '#3d2c55'],
  ['--popover', '#ffffff'],
  ['--popover-foreground', '#3d2c55'],
  ['--primary', '#7b5ea7'],
  ['--primary-hover', '#5e4590'],
  ['--primary-foreground', '#ffffff'],
  ['--secondary', '#f1ecf8'],
  ['--secondary-foreground', '#3d2c55'],
  ['--muted', '#f1ecf8'],
  ['--muted-foreground', '#6e5b87'],
  ['--accent', '#efe8fa'],
  ['--accent-foreground', '#3d2c55'],
  ['--destructive', '#d64545'],
  ['--attention', '#ff8a3d'],
  ['--attention-foreground', '#3d2c55'],
  ['--attention-strong', '#a04a06'],
  ['--success', '#4caf6e'],
  ['--success-foreground', '#ffffff'],
  ['--success-strong', '#26703f'],
  ['--border', '#e4dbf0'],
  ['--input', '#e4dbf0'],
  ['--ring', '#7b5ea7'],
  ['--chart-1', '#7b5ea7'],
  ['--chart-2', '#4caf6e'],
  ['--chart-3', '#ff8a3d'],
  ['--chart-4', '#b79ce0'],
  ['--chart-5', '#3d2c55'],
  ['--sidebar', '#f3eefb'],
  ['--sidebar-foreground', '#3d2c55'],
  ['--sidebar-primary', '#7b5ea7'],
  ['--sidebar-primary-foreground', '#ffffff'],
  ['--sidebar-accent', '#e7def7'],
  ['--sidebar-accent-foreground', '#3d2c55'],
  ['--sidebar-border', '#ded2f0'],
  ['--sidebar-ring', '#7b5ea7'],
];

const DARK: Array<[string, string]> = [
  ['--background', '#1a1523'],
  ['--foreground', '#e6ddf5'],
  ['--card', '#241d30'],
  ['--card-foreground', '#e6ddf5'],
  ['--popover', '#241d30'],
  ['--popover-foreground', '#e6ddf5'],
  ['--primary', '#b79ce0'],
  ['--primary-hover', '#c9b4ea'],
  ['--primary-foreground', '#1a1523'],
  ['--secondary', '#2e2540'],
  ['--secondary-foreground', '#e6ddf5'],
  ['--muted', '#2e2540'],
  ['--muted-foreground', '#a695c2'],
  ['--accent', '#342a47'],
  ['--accent-foreground', '#e6ddf5'],
  ['--destructive', '#f08a8a'],
  ['--attention', '#ff9e5e'],
  ['--attention-foreground', '#1a1523'],
  ['--attention-strong', '#ff9e5e'],
  ['--success', '#6fcb8e'],
  ['--success-foreground', '#1a1523'],
  ['--success-strong', '#6fcb8e'],
  ['--border', '#362c4a'],
  ['--input', '#3f3355'],
  ['--ring', '#b79ce0'],
  ['--chart-1', '#b79ce0'],
  ['--chart-2', '#6fcb8e'],
  ['--chart-3', '#ff9e5e'],
  ['--chart-4', '#8e77be'],
  ['--chart-5', '#e6ddf5'],
  ['--sidebar', '#201a2c'],
  ['--sidebar-foreground', '#e6ddf5'],
  ['--sidebar-primary', '#b79ce0'],
  ['--sidebar-primary-foreground', '#1a1523'],
  ['--sidebar-accent', '#2e2540'],
  ['--sidebar-accent-foreground', '#e6ddf5'],
  ['--sidebar-border', '#362c4a'],
  ['--sidebar-ring', '#b79ce0'],
];

// Only --text-micro is an override — it's the one real change to the ramp
// (see reference.md's Type ramp section). The other five steps (xs/sm/base/
// lg/2xl) are deliberately NOT redeclared here: Tailwind v4's shipped rem
// defaults already match them exactly, and hard-pinning them in px would
// break the browser's default-font-size scaling (an app-wide a11y
// regression) for zero visual gain.
const TYPE: Array<[string, string]> = [
  ['--text-micro', '0.6875rem'],
  ['--text-micro--line-height', '1rem'],
];

describe('Lapin design tokens (ui/src/index.css)', () => {
  it('imports the Nunito variable font', () => {
    expect(css).toContain('@import "@fontsource-variable/nunito";');
  });

  it('defines --font-display using Nunito Variable', () => {
    expect(css).toMatch(/--font-display:\s*"Nunito Variable"/);
  });

  it('points --font-heading at --font-display', () => {
    expect(css).toContain('--font-heading: var(--font-display);');
  });

  it.each(LIGHT)('sets :root token %s to %s', (name, value) => {
    expect(rootBlock).toContain(`${name}: ${value};`);
  });

  it.each(DARK)('sets .dark token %s to %s', (name, value) => {
    expect(darkBlock).toContain(`${name}: ${value};`);
  });

  it.each(TYPE)('sets @theme inline token %s to %s', (name, value) => {
    expect(themeBlock).toContain(`${name}: ${value};`);
  });

  it('sets the base radius to 1rem', () => {
    expect(rootBlock).toContain('--radius: 1rem;');
  });

  it('defines the hop utility with the frozen motion tokens', () => {
    expect(css).toContain('@utility hop {');
    const hopBlock = extractBlock('@utility hop');
    expect(hopBlock).toContain('var(--duration-hop)');
    expect(hopBlock).toContain('var(--ease-hop)');
  });

  it('guards transitions and animations under prefers-reduced-motion', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('transition-duration: 1ms !important;');
  });
});

// ---- Contrast ratios (QA round 1 bug 8, AC 1) --------------------------
// AC 1: "the check is automated and listed pair by pair. A pair that
// fails is a build failure, not a note." Before this, `reference.md`'s
// contrast table was a hand-computed note nothing enforced — the hex pins
// above catch a colour *change* but never a contrast *violation* as such.
// This is a small, dependency-free WCAG 2.1 relative-luminance/contrast-
// ratio implementation (the formula itself, not a library) — no new
// runtime dependency, matching AC 5's own constraint.

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG 2.1 contrast ratio between two sRGB hex colours, order-independent. */
function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

function readVar(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`));
  if (!match?.[1]) throw new Error(`token not found: ${name}`);
  return match[1];
}

const WCAG_AA_NORMAL_TEXT = 4.5;

// ---- Derive enforced contrast pairs from reference.md (QA round 2 bug
// R2-1) --------------------------------------------------------------------
// Before this, `CONTRAST_PAIRS` was a hand-maintained array duplicating a
// subset of reference.md's "Contrast pairs" table — the two could (and did)
// drift: the table gained a `muted-foreground` on `background` row the array
// never picked up, so its published numbers (5.60/6.63) were never checked
// against the real tokens (actually 5.67/6.55). Closing the class, not the
// instance: the table itself is now the single source of truth. Every row
// is parsed out, and for every row marked `pass` we assert both that the
// computed ratio clears 4.5:1 *and* that the published number matches the
// computed one — so a hand-edited wrong number in the doc is a build
// failure, not a silent duplicate-source bug. Rows marked FAIL (fill-only
// colours with no text use) are checked for numeric accuracy only, since
// they're deliberately below threshold and only the light mode is
// published for them.

interface ContrastRow {
  fg: string;
  bg: string;
  label: string;
  lightPublished: number;
  darkPublished: number | null;
  isPass: boolean;
}

const CONTRAST_ROW_RE =
  /^\|\s*`([a-z][a-z-]*)`\s*(?:\([a-z ]+\)\s*)?on\s*`([a-z][a-z-]*)`\s*\|\s*([\d.]+):1\s*\|\s*(—|[\d.]+:1)\s*\|\s*(.+?)\s*\|$/;

/** Parses reference.md's "Contrast pairs" markdown table into structured rows. */
function parseContrastTable(md: string): ContrastRow[] {
  const tableStart = md.indexOf('| Pair | Light | Dark | Verdict |');
  if (tableStart === -1)
    throw new Error('Contrast pairs table not found in reference.md');
  const tableEnd = md.indexOf('\n\n', tableStart);
  const tableBlock = md.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);

  const rows: ContrastRow[] = [];
  for (const line of tableBlock.split('\n').slice(2)) {
    const match = line.match(CONTRAST_ROW_RE);
    if (!match) continue;
    const [, fg, bg, light, dark, verdict] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({
      fg,
      bg,
      label: `${fg} on ${bg}`,
      lightPublished: Number.parseFloat(light),
      darkPublished: dark === '—' ? null : Number.parseFloat(dark),
      isPass: verdict.trim() === 'pass',
    });
  }
  return rows;
}

const contrastRows = parseContrastTable(referenceMd);

/** Pairs that must exist as `pass` rows in reference.md's table — a row
 * deleted from the doc must fail loudly here instead of silently dropping
 * out of enforcement. */
const REQUIRED_PASS_PAIRS: Array<[string, string]> = [
  ['foreground', 'card'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'background'],
  ['primary', 'card'],
  ['success-strong', 'card'],
  ['destructive-strong', 'card'],
  ['attention-strong', 'card'],
  ['foreground', 'background'],
  ['primary-foreground', 'primary'],
];

describe('Contrast ratios (AC 1 — derived from reference.md, WCAG 2.1)', () => {
  it('sanity: white on black is 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('sanity: identical colours are 1:1', () => {
    expect(contrastRatio('#7b5ea7', '#7b5ea7')).toBeCloseTo(1, 5);
  });

  it('found at least one contrast row in reference.md', () => {
    expect(contrastRows.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_PASS_PAIRS)(
    'reference.md documents %s on %s as a pass row',
    (fg, bg) => {
      const found = contrastRows.find((r) => r.fg === fg && r.bg === bg && r.isPass);
      expect(found, `missing pass row: \`${fg}\` on \`${bg}\``).toBeDefined();
    },
  );

  it.each(contrastRows)(
    '$label: light ratio matches reference.md and clears threshold if pass',
    (row) => {
      const lightRatio = contrastRatio(
        readVar(rootBlock, `--${row.fg}`),
        readVar(rootBlock, `--${row.bg}`),
      );
      expect(
        Number(lightRatio.toFixed(2)),
        `${row.label} (light) computed ${lightRatio.toFixed(2)}:1 vs published ${row.lightPublished}:1`,
      ).toBe(row.lightPublished);
      if (row.isPass) {
        expect(
          lightRatio,
          `${row.label} (light) = ${lightRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      }
    },
  );

  it.each(contrastRows.filter((r) => r.darkPublished !== null))(
    '$label: dark ratio matches reference.md and clears threshold if pass',
    (row) => {
      const darkRatio = contrastRatio(
        readVar(darkBlock, `--${row.fg}`),
        readVar(darkBlock, `--${row.bg}`),
      );
      expect(
        Number(darkRatio.toFixed(2)),
        `${row.label} (dark) computed ${darkRatio.toFixed(2)}:1 vs published ${row.darkPublished}:1`,
      ).toBe(row.darkPublished);
      if (row.isPass) {
        expect(
          darkRatio,
          `${row.label} (dark) = ${darkRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      }
    },
  );
});

const TEXT_RAMP: Array<[string, string]> = [
  ['--text-micro', '0.6875rem'],
  ['--text-xs', '0.75rem'],
  ['--text-sm', '0.875rem'],
  ['--text-base', '1rem'],
  ['--text-lg', '1.125rem'],
  ['--text-2xl', '1.5rem'],
];

const RESERVED_WORDS: string[] = [
  'reconcile',
  'farm',
  'source',
  'compress',
  'structure',
  'assemble',
  'filter',
  'dedup',
  'rank',
  'sync',
  'LinkedIn',
  'Greenhouse',
  'Keka',
  'Run',
  'Job',
  'Profile',
  ...STATUS_OPTIONS,
  ...EXCITEMENT_OPTIONS,
  'Apply',
  'Lead',
  'Pass',
  'Save',
  'Match score',
];

describe('Design system reference document (docs/product/ui-design-system/reference.md)', () => {
  it.each(TEXT_RAMP)('documents %s at %s', (name, px) => {
    expect(referenceMd).toContain(name);
    expect(referenceMd).toContain(px);
  });

  it.each(RESERVED_WORDS.map((w) => [w] as const))(
    'documents the reserved word %s',
    (word) => {
      expect(referenceMd).toContain(word);
    },
  );
});
