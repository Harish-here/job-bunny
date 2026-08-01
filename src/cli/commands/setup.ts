/**
 * commands/setup.ts (P8) — `setup --profile <p>`: an idempotent,
 * resumable step list covering the non-interactive spine of onboarding
 * (the interactive wizard — Notion adopt-or-create, secrets prompt —
 * stays in the `/setup` slash command). Every step runs regardless of
 * earlier results and self-reports `done`/`skipped`/`needs-action`; the
 * command exits 0 iff every step is done-or-skipped, 1 if any needs
 * action. The scaffold step is the only thing here allowed to write —
 * it delegates to `seedProfileFiles` (same rules as `profile build`) so
 * this command never mutates anything outside `profiles/<p>/`.
 *
 * Steps: profile scaffold, .env NOTION_TOKEN (skipped for a local-only
 * sqlite profile — only checked when `connector === 'notion'` or the
 * sqlite→Notion mirror is active, mirroring `mirrorSettings()` in
 * `cli/wire/builders.ts`), resume.json, search_urls.md, page_inventory
 * coverage (checks the `.json` inventory — the runtime authority per
 * `adapters/lanes/linkedin/inventory.ts`), and ui build (checks
 * `ui/dist/index.html`).
 *
 * No `src/adapters/**` import — all filesystem access goes through
 * injected deps so tests use a temp dir and never touch the real
 * `profiles/` or `.env`.
 */
import path from 'node:path';
import { defaultProfileFsDeps, type ProfileFsDeps, seedProfileFiles } from './profile.ts';

export type StepStatus = 'done' | 'skipped' | 'needs-action';

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface SetupOptions {
  profile: string;
}

export type SetupDeps = ProfileFsDeps;

function defaultDeps(): SetupDeps {
  return defaultProfileFsDeps();
}

async function stepScaffold(profileDir: string, deps: SetupDeps): Promise<StepResult> {
  const results = await seedProfileFiles(profileDir, deps);
  const created = results.filter((r) => r.status === 'created').map((r) => r.file);
  if (created.length === 0) {
    return {
      step: 'profile scaffold',
      status: 'done',
      detail: 'all scaffold files present',
    };
  }
  return {
    step: 'profile scaffold',
    status: 'done',
    detail: `seeded missing file(s): ${created.join(', ')}`,
  };
}

// Never prints or returns the token value itself — only whether it is set.
function envHasKey(text: string, key: string): boolean {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return !!match?.[1] && match[1].trim().length > 0;
}

interface ConnectorNeeds {
  notionNeeded: boolean;
  problem: string | null;
}

// The scaffold step runs first and seeds profile.json, so "missing" is
// only reachable when seeding itself failed — still reported, never thrown.
async function readConnectorNeeds(
  profileDir: string,
  deps: SetupDeps,
): Promise<ConnectorNeeds> {
  const p = path.join(profileDir, 'profile.json');
  if (!(await deps.exists(p))) {
    return { notionNeeded: false, problem: 'profile.json missing' };
  }
  try {
    const parsed = JSON.parse(await deps.readFile(p)) as {
      connector?: unknown;
      settings?: { notion?: { mirror?: unknown; dbId?: unknown } };
    };
    const notion = parsed.settings?.notion;
    // Mirrors mirrorSettings() in cli/wire/builders.ts: mirror=true without a
    // non-empty dbId is pinned as NO mirror — so no token needed either.
    const mirrorActive =
      notion?.mirror === true &&
      typeof notion.dbId === 'string' &&
      notion.dbId.length > 0;
    return {
      notionNeeded: parsed.connector === 'notion' || mirrorActive,
      problem: null,
    };
  } catch {
    return { notionNeeded: false, problem: 'profile.json is not valid JSON' };
  }
}

async function stepNotionToken(
  root: string,
  profileDir: string,
  deps: SetupDeps,
): Promise<StepResult> {
  const step = '.env NOTION_TOKEN';
  const needs = await readConnectorNeeds(profileDir, deps);
  if (needs.problem) {
    return { step, status: 'needs-action', detail: `${needs.problem} — run doctor` };
  }
  if (!needs.notionNeeded) {
    return {
      step,
      status: 'skipped',
      detail: 'local sqlite profile — Notion token not needed',
    };
  }
  const envPath = path.join(root, '.env');
  if (!(await deps.exists(envPath))) {
    return { step, status: 'needs-action', detail: '.env not found' };
  }
  const text = await deps.readFile(envPath);
  if (envHasKey(text, 'NOTION_TOKEN')) {
    return { step, status: 'done', detail: 'present' };
  }
  return { step, status: 'needs-action', detail: 'not set — add NOTION_TOKEN to .env' };
}

async function stepResume(profileDir: string, deps: SetupDeps): Promise<StepResult> {
  const p = path.join(profileDir, 'resume.json');
  if (await deps.exists(p)) {
    return { step: 'resume.json', status: 'done', detail: 'present' };
  }
  return {
    step: 'resume.json',
    status: 'needs-action',
    detail: `missing — fill in ${p}`,
  };
}

function countUrls(text: string): number {
  return (text.match(/^\s*•\s.+-\s*\S+/gm) || []).length;
}

function extractReferencedPages(text: string): string[] {
  const pages = new Set<string>();
  const re = /^###\s+(\S+)/gm;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    if (m[1]) pages.add(m[1]);
    m = re.exec(text);
  }
  return [...pages];
}

async function stepSearchUrls(
  profileDir: string,
  deps: SetupDeps,
): Promise<{ result: StepResult; text: string }> {
  const p = path.join(profileDir, 'search_urls.md');
  if (!(await deps.exists(p))) {
    return {
      result: { step: 'search_urls.md', status: 'needs-action', detail: 'missing' },
      text: '',
    };
  }
  const text = await deps.readFile(p);
  const count = countUrls(text);
  if (count > 0) {
    return {
      result: { step: 'search_urls.md', status: 'done', detail: `${count} URL(s)` },
      text,
    };
  }
  return {
    result: {
      step: 'search_urls.md',
      status: 'needs-action',
      detail: 'no URLs yet — add one with `lane add-url`',
    },
    text,
  };
}

async function stepInventory(
  root: string,
  searchUrlsText: string,
  deps: SetupDeps,
): Promise<StepResult> {
  const pages = extractReferencedPages(searchUrlsText);
  if (pages.length === 0) {
    return {
      step: 'page_inventory coverage',
      status: 'skipped',
      detail: 'no page-types referenced yet',
    };
  }
  const missing: string[] = [];
  for (const page of pages) {
    const p = path.join(
      root,
      'src',
      'adapters',
      'lanes',
      'linkedin',
      'page_inventory',
      `${page}.json`,
    );
    if (!(await deps.exists(p))) missing.push(page);
  }
  if (missing.length === 0) {
    return {
      step: 'page_inventory coverage',
      status: 'done',
      detail: `${pages.length} page-type(s) covered`,
    };
  }
  return {
    step: 'page_inventory coverage',
    status: 'needs-action',
    detail: `missing inventory for: ${missing.join(', ')} — run /page-analyse`,
  };
}

async function stepUiBuilt(root: string, deps: SetupDeps): Promise<StepResult> {
  const p = path.join(root, 'ui', 'dist', 'index.html');
  if (await deps.exists(p)) {
    return { step: 'ui build', status: 'done', detail: 'ui/dist present' };
  }
  return {
    step: 'ui build',
    status: 'needs-action',
    detail: 'board UI not built — run: npm run ui:build',
  };
}

export async function setupCommand(
  opts: SetupOptions,
  deps: Partial<SetupDeps> = {},
): Promise<number> {
  const resolved: SetupDeps = { ...defaultDeps(), ...deps };
  const profileDir = path.join(resolved.root, 'profiles', opts.profile);

  const steps: StepResult[] = [];
  steps.push(await stepScaffold(profileDir, resolved));
  steps.push(await stepNotionToken(resolved.root, profileDir, resolved));
  steps.push(await stepResume(profileDir, resolved));
  const { result: searchUrlsResult, text } = await stepSearchUrls(profileDir, resolved);
  steps.push(searchUrlsResult);
  steps.push(await stepInventory(resolved.root, text, resolved));
  steps.push(await stepUiBuilt(resolved.root, resolved));

  for (const s of steps) {
    resolved.write(`[setup] ${s.step}: ${s.status} — ${s.detail}`);
  }

  return steps.some((s) => s.status === 'needs-action') ? 1 : 0;
}
