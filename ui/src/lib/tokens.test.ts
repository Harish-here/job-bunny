// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXCITEMENT_OPTIONS, STATUS_OPTIONS } from '../../../src/core/tracking/vocab.ts';

const cssPath = fileURLToPath(new URL('../index.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

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

const referencePath = fileURLToPath(
  new URL('../../../docs/product/ui-design-system/reference.md', import.meta.url),
);
const referenceMd = readFileSync(referencePath, 'utf8');

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
