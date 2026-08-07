/**
 * commands/setup.ts (P8; config→db Phase 4, Task 5) — `setup --profile
 * <p>`: an idempotent, resumable step list covering the non-interactive
 * spine of onboarding (the interactive wizard — Notion adopt-or-create,
 * secrets prompt — stays in the `/setup` slash command). Every step runs
 * regardless of earlier results and self-reports
 * `done`/`skipped`/`needs-action`; the command exits 0 iff every step is
 * done-or-skipped, 1 if any needs action. The scaffold step is the only
 * thing here allowed to write — it delegates to `seedProfileDocs` (same
 * rules as `profile build`) so this command never mutates anything
 * outside `profiles/<p>/`.
 *
 * Steps: profile scaffold, .env NOTION_TOKEN (skipped for a local-only
 * sqlite profile — only checked when `connector === 'notion'` or the
 * sqlite→Notion mirror is active, mirroring `mirrorSettings()` in
 * `cli/wire/builders.ts`), resume.json, search_urls.md, page_inventory
 * coverage (checks the `.json` inventory — the runtime authority per
 * `adapters/lanes/linkedin/inventory.ts`), and ui build (checks
 * `ui/dist/index.html`).
 *
 * `readConnectorNeeds`/`stepResume`/`stepSearchUrls` read their one config
 * doc each (`profile.json`/`resume.json`/`search_urls.md`) through a
 * short-lived, READWRITE `ConfigStore` (`SetupDeps.configStore` — this is
 * a meaningful first-use context, same posture as `migrate`) rather than
 * `ProfileFsDeps.exists`/`readFile` directly. `stepScaffold` now ALSO goes
 * through that same injected `configStore` (config→db Phase 4, Task 7 —
 * it delegates to `seedProfileDocs`, `profile.ts`'s own config-doc
 * writer), so every step in this command shares one config-doc seam.
 * `stepInventory`/`stepUiBuilt`/`stepNotionToken`'s own `.env` read are
 * UNCHANGED — they stay on the plain fs deps (the linkedin inventory
 * check and `.env` are unrelated to Task 7's scope). This module sits
 * under `cli/commands/`, not the `only-wire-imports-adapters` carve-out,
 * so it reaches the store only through `wireConfigStore` (a plain
 * function import from `../wire/index.ts`, never `src/adapters/**`
 * directly) — exactly like `doctorCommand`/`stateCommand` already do.
 *
 * No `src/adapters/**` import — all filesystem access goes through
 * injected deps so tests use a temp dir and never touch the real
 * `profiles/` or `.env`.
 */
import path from 'node:path';
import type { ConfigStore } from '../../ports/config_store.ts';
import { wireConfigStore } from '../wire/index.ts';
import { defaultProfileFsDeps, type ProfileFsDeps, seedProfileDocs } from './profile.ts';

export type StepStatus = 'done' | 'skipped' | 'needs-action';

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface SetupOptions {
  profile: string;
}

export interface SetupDeps extends ProfileFsDeps {
  /** Test seam — a factory so each of the three config-doc-reading steps
   * scopes and closes its OWN short-lived store, never a shared/memoized
   * instance. Default: `(name) => wireConfigStore(name, { root })`, where
   * `root` is the FINAL resolved root (`setupCommand`'s own `deps.root`
   * override, if any) — never a pre-merge snapshot. */
  configStore: (profileName: string) => ConfigStore;
}

function defaultDeps(): ProfileFsDeps {
  return defaultProfileFsDeps();
}

async function stepScaffold(profileName: string, deps: SetupDeps): Promise<StepResult> {
  const results = await seedProfileDocs(profileName, deps);
  const created = results.filter((r) => r.status === 'created').map((r) => r.doc);
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
// Reads via a short-lived ConfigStore (config→db Phase 4) rather than
// `deps.exists`/`deps.readFile`; the WHOLE probe (store construction,
// `readText`, `JSON.parse`, connector-field extraction) is one try/catch —
// a legacy `profile.json` malformed enough that `SqliteConfigStore`'s own
// lift-time check rejects it surfaces here exactly like a `JSON.parse`
// failure always did.
async function readConnectorNeeds(
  profileDir: string,
  deps: SetupDeps,
): Promise<ConnectorNeeds> {
  const store = deps.configStore(path.basename(profileDir));
  try {
    const raw = await store.readText('profile.json');
    if (raw === undefined) {
      return { notionNeeded: false, problem: 'profile.json missing' };
    }
    const parsed = JSON.parse(raw) as {
      connector?: unknown;
      settings?: { notion?: { mirror?: unknown; dbId?: unknown } };
    };
    const notion = parsed.settings?.notion;
    // Mirrors mirrorSettings() in cli/wire/builders.ts: mirror=true without a
    // non-empty dbId is pinned as NO mirror — so no token needed either.
    const mirrorActive =
      parsed.connector === 'sqlite' &&
      notion?.mirror === true &&
      typeof notion.dbId === 'string' &&
      notion.dbId.length > 0;
    return {
      notionNeeded: parsed.connector === 'notion' || mirrorActive,
      problem: null,
    };
  } catch {
    return { notionNeeded: false, problem: 'profile.json is not valid JSON' };
  } finally {
    store.close();
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
  const store = deps.configStore(path.basename(profileDir));
  let raw: string | undefined;
  try {
    raw = await store.readText('resume.json');
  } catch {
    // A legacy resume.json malformed enough to fail SqliteConfigStore's
    // loose lift-time check (JSON.parse) — tolerant posture, same as
    // "missing" (this step never validated JSON shape, only presence).
    raw = undefined;
  } finally {
    store.close();
  }
  if (raw !== undefined) {
    return { step: 'resume.json', status: 'done', detail: 'present' };
  }
  return {
    step: 'resume.json',
    status: 'needs-action',
    detail: `missing — fill in ${path.join(profileDir, 'resume.json')}`,
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
  const store = deps.configStore(path.basename(profileDir));
  let raw: string | undefined;
  try {
    raw = await store.readText('search_urls.md');
  } catch {
    // A legacy search_urls.md failing SqliteConfigStore's loose lift-time
    // check (empty file) — tolerant posture, degrade to "missing" rather
    // than crashing the whole setup run over one step.
    raw = undefined;
  } finally {
    store.close();
  }
  if (raw === undefined) {
    return {
      result: { step: 'search_urls.md', status: 'needs-action', detail: 'missing' },
      text: '',
    };
  }
  const text = raw;
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
  const fsDeps: ProfileFsDeps = { ...defaultDeps(), ...deps };
  // The default `configStore` binds to `fsDeps.root` — the FINAL resolved
  // root, honoring a caller's `root` override even when it doesn't also
  // override `configStore` (every test in this file does exactly that).
  const resolved: SetupDeps = {
    ...fsDeps,
    configStore:
      deps.configStore ?? ((name) => wireConfigStore(name, { root: fsDeps.root })),
  };
  const profileDir = path.join(resolved.root, 'profiles', opts.profile);

  const steps: StepResult[] = [];
  // Must run first: on a brand-new machine `<root>/profiles/` does not
  // exist yet, and the profile's SQLite config store (opened at
  // `<root>/profiles/<name>/data/jobbunny.db` by `stepScaffold` below)
  // would otherwise surface a raw ENOENT instead of scaffolding the home.
  const profilesDir = path.join(resolved.root, 'profiles');
  await resolved.mkdir(profilesDir);
  steps.push({ step: 'home', status: 'done', detail: resolved.root });
  steps.push(await stepScaffold(opts.profile, resolved));
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
