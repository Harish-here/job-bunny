# UI Workspace (Board SPA) + Local-First Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship PR 5 of the local-DB adoption (spec §6): a `ui/` npm workspace holding a Vite + Svelte + TypeScript SPA (sidebar shell, hash router, profile switcher, live Board with filter/sort/detail-drawer/inline tracking edits, stubbed Analytics/Onboarding), served by the existing `jobbunny board` static handler — plus the user-approved fold-in: a local-first `/setup` flow (`jobbunny setup` skips the Notion token for sqlite-only profiles, checks the UI build, and the `/setup` wizard makes Notion an opt-in mirror branch).

**Architecture:** `ui/` is an npm workspace whose deps never touch the root's 4 runtime deps; it consumes the board HTTP API and imports response types **type-only** from `src/app/features/*/index.ts` (zero runtime coupling — `verbatimModuleSyntax` enforces erasure). Frontend mirrors backend slices (`ui/src/features/board/` etc.); shared plumbing (api client, router, profile store) lives in `ui/src/lib/` as plain TS testable under vitest's node environment — no jsdom, no component-render tests in v1 (`vite build` + `svelte-check` gate the components). The pipeline gate (`npm run check`) is untouched; ui gets its own `ui:check`/`ui:build` scripts and a separate ubuntu-only CI job.

**Tech Stack:** vite 8.2.0, svelte 5.56.8 (runes), @sveltejs/vite-plugin-svelte 7.2.0, vitest 4.1.10, svelte-check 4.7.4, typescript ^5.9 (ui-local — root stays on TS 7), @tsconfig/svelte 5.0.8. All peer-verified against each other and Node 24 (vitest 4.1.10 peers `vite ^6||^7||^8`).

## Global Constraints

- Branch: `feat/ui-workspace` from `main-db` @ `15288c7`. Worktree `/Users/harishamutha/Job-bunny-local-db`. Never push to origin; never touch the `/Users/harishamutha/Job-bunny` checkout.
- Node ≥ 24 (`.nvmrc`); root `dependencies` stay exactly 4 (`@notionhq/client`, `dotenv`, `playwright`, `zod`). `ui/package.json` has **devDependencies only — no `dependencies` key** (Svelte compiles away; the SPA bundles no runtime deps).
- Root `npm run check` must be green after every task (baseline **1286** tests at `15288c7`; src-touching tasks 2, 7, 8 may grow the count). Run it via `bash -c "npm run check"` and verify exit 0 (`echo EXIT:$?`).
- File caps apply to `src/**` only (impl ≤ 400 / test ≤ 800). Near-cap files that must NOT grow: `cli/wire/compose.ts` 390/400, `cli/wire/builders.ts` 390/400, `cli/wire/compose.test.ts` 800/800, `adapters/lanes/linkedin/lane.ts` 400/400. No task here touches them.
- TS7 `erasableSyntaxOnly` in `src/**`: no enums, no parameter properties. `noUncheckedIndexedAccess` is on in both tsconfigs — index reads need `?? fallback`.
- Vocabulary strings (`STATUS_OPTIONS`, `EXCITEMENT_OPTIONS` in `src/core/tracking/vocab.ts`) are byte-exact against the live Notion DB — never edit them; the UI only reads them via `GET /api/profiles/:name/meta`.
- The board server binds `127.0.0.1` only. Runtime checks use ONLY throwaway profiles (`zzuicheck`) with `env -u NOTION_TOKEN`; **never** run anything against `profiles/harish/` and never PATCH any profile other than the throwaway.
- Commit per task, conventional messages (`feat(ui): …`, `fix(cli): …`). **No Claude co-author trailers or "Generated with" attribution.**
- `ui/dist/` is gitignored (Task 1); never commit build output. `package-lock.json` changes from the workspace **are** committed (CI `npm ci` requires lockfile agreement).
- API contract (frozen by PR 4 — the UI adapts to it, never the reverse): routes `GET /api/profiles`, `GET /api/profiles/:name/jobs`, `GET /api/profiles/:name/jobs/:id`, `PATCH /api/profiles/:name/jobs/:id/tracking`, `GET /api/profiles/:name/meta`; list params `status, excitement, company, dateFrom, dateTo, archived('true'|'false'), sort('date_found'|'score'), order('asc'|'desc'), limit(1–200), offset`; error envelope `{"error":{"code","message"}}` with codes `validation, not_found, no_local_db, bad_request, bad_json, too_large, internal`; tracking PATCH is `z.strictObject` (unknown keys rejected), `.refine` non-empty, `null` clears a field / absent keeps it.
- **`archived` is two-state, never "all":** the adapter (`board.ts`) always emits `jobs.archived = ?`, with absent treated as `false` — so `'false'`/absent = active only, `'true'` = archived only. There is no combined view; the UI models this as an Active/Archived toggle, not an "include archived" checkbox.
- **Tooling scopes are deliberate and stay put:** `biome.json`, `.dependency-cruiser.cjs`, and the filesize invariant remain scoped to `src/**` — no task widens them. `ui/` is gated by `svelte-check` + `vitest` + `vite build` only.

## File Structure (end state)

```
package.json                 # + "workspaces": ["ui"], + ui:build/ui:dev/ui:check scripts
.gitignore                   # + ui/dist/
.github/workflows/test.yml   # + ui job (ubuntu), test wrapper needs both
ui/
  package.json               # jobbunny-ui, private, devDeps only
  tsconfig.json              # extends @tsconfig/svelte; bundler resolution; allowImportingTsExtensions
  vite.config.ts             # svelte plugin, /api dev proxy → 127.0.0.1:4646, vitest node env
  index.html
  src/
    main.ts                  # mount(App)
    app.css                  # global layout (shell/sidebar/pager); feature styles are component-scoped
    App.svelte               # shell composition: router + profile store + page outlet
    lib/
      api/
        types.ts             # type-only re-exports from src/app feature barrels
        client.ts            # ApiError, buildQuery, getJson, patchJson
        client.test.ts
      router.ts              # parseHash + createRouter (svelte/store, injectable window)
      router.test.ts
      profile.ts             # createProfileStore (localStorage-persisted current profile)
      profile.test.ts
    features/
      shell/
        Sidebar.svelte
        ProfileSwitcher.svelte
      board/
        api.ts               # typed endpoint wrappers (listJobs/getJob/patchTracking/getMeta)
        api.test.ts
        BoardPage.svelte     # state owner: query/data/meta/drawer selection
        FilterBar.svelte
        JobTable.svelte
        JobDrawer.svelte
        TrackingForm.svelte
        tracking.ts          # applyPatch optimistic-merge helper (pure)
        tracking.test.ts
      analytics/AnalyticsPage.svelte    # stub
      onboarding/OnboardingPage.svelte  # stub
src/app/features/board/index.ts     # + type re-exports: BoardJobRow, BoardJobDetail, TrackingRow
src/app/features/profiles/index.ts  # + type re-export: BoardProfile
src/app/server/static.ts            # NO_UI_MESSAGE drops "(arrives with PR 5)"
src/app/server/static.test.ts       # expectation updated
src/cli/commands/setup.ts           # Notion-conditional token step, ui-build step, .md→.json inventory bugfix
src/cli/commands/setup.test.ts      # extended
.claude/commands/setup.md           # local-first rewrite (full text in Task 8)
```

---

### Task 1: `ui/` workspace scaffolding + root wiring

**Files:**
- Modify: `package.json` (root)
- Modify: `.gitignore`
- Create: `ui/package.json`, `ui/tsconfig.json`, `ui/vite.config.ts`, `ui/index.html`, `ui/src/main.ts`, `ui/src/App.svelte` (placeholder — replaced in Task 4), `ui/src/app.css` (placeholder — replaced in Task 4)
- Modify: `package-lock.json` (regenerated by `npm install` — commit it)

**Interfaces:**
- Consumes: nothing.
- Produces: workspace commands later tasks rely on — root `npm run ui:build` (emits `ui/dist/`), `npm run ui:check` (delegates to ui's `check` script = `svelte-check` for now; Task 2 appends `&& vitest run`), `npm run ui:dev` (Vite dev server proxying `/api` → `http://127.0.0.1:4646`). Entry chain `index.html → src/main.ts → src/App.svelte` + global stylesheet `src/app.css`.

- [x] **Step 1: Create the branch**

```bash
cd /Users/harishamutha/Job-bunny-local-db
git checkout main-db && git rev-parse --short HEAD   # expect 15288c7
git checkout -b feat/ui-workspace
bash -c "npm run check"   # baseline green: 1286 tests, EXIT:0
```

- [x] **Step 2: Root `package.json`** — add a `workspaces` key after `"private": true`, and three scripts. The `dependencies`/`devDependencies` blocks are NOT touched.

```json
  "private": true,
  "workspaces": ["ui"],
```

Scripts block gains (keep existing entries verbatim):

```json
    "ui:build": "npm run build --workspace ui",
    "ui:dev": "npm run dev --workspace ui",
    "ui:check": "npm run check --workspace ui",
```

- [x] **Step 3: `.gitignore`** — append at the end:

```
# Board UI build output — rebuilt any time with `npm run ui:build`
ui/dist/
```

(`ui/node_modules/` needs no rule — the existing bare `node_modules/` pattern matches nested directories.)

- [x] **Step 4: `ui/package.json`** (exact content):

```json
{
  "name": "jobbunny-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^7.2.0",
    "@tsconfig/svelte": "^5.0.8",
    "svelte": "^5.56.8",
    "svelte-check": "^4.7.4",
    "typescript": "^5.9.2",
    "vite": "^8.2.0",
    "vitest": "^4.1.10"
  }
}
```

Note: `typescript` here is deliberately ^5 (svelte-check's peer range) while the root has TS 7 (the Go port — svelte-check cannot bind its API). npm must resolve the conflict by nesting BOTH `svelte-check` and `typescript@5` under `ui/node_modules/`. **Watch-item:** after `npm install`, run `ls ui/node_modules` — `svelte-check` and `typescript` must both appear there (nested); if either hoisted to the root, svelte-check will bind root TS 7 and crash or misbehave. Fallback if so: pin `"typescript": "5.9.2"` exact (no caret) in `ui/package.json`, `rm -rf node_modules ui/node_modules package-lock.json && npm install`, re-probe; if still hoisted, report BLOCKED rather than improvising. (`vitest run` before Task 2 adds test files exits non-zero with "No test files found" — expected; no task runs it before then.)

- [x] **Step 5: `ui/tsconfig.json`** (exact content):

```json
{
  "extends": "@tsconfig/svelte/tsconfig.json",
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node", "svelte", "vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

`"node"` is load-bearing: the type chase from `ui/src/lib/api/types.ts` reaches `src/app/shared/http.ts`, which imports `IncomingMessage` from `node:http` — without `@types/node` (a root devDependency, hoisted and resolvable from `ui/`) the chased types silently degrade to `any` and every UI type check becomes vacuous.

- [x] **Step 6: `ui/vite.config.ts`** (exact content):

```ts
/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Dev server proxies API calls to a locally running `jobbunny board`
// (default port 4646). Production build is served BY that server from
// ui/dist, same origin — no proxy involved.
// NOTE: this file sits outside tsconfig's include on purpose — the
// vitest/config reference helps editors only; Vite loads it with its own
// pipeline, and svelte-check never validates it. Don't "fix" the include.
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:4646' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [x] **Step 7: `ui/index.html`** (exact content):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Job Bunny</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [x] **Step 8: `ui/src/main.ts`** (exact content):

```ts
import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app') as HTMLElement });
```

- [x] **Step 9: placeholder `ui/src/App.svelte`** (replaced wholesale in Task 4):

```svelte
<script lang="ts">
  const title = 'Job Bunny';
</script>

<main>
  <h1>{title}</h1>
  <p>Board UI shell arrives in later tasks.</p>
</main>
```

and placeholder `ui/src/app.css`:

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
}
body {
  margin: 0;
}
```

- [x] **Step 10: Install + verify**

```bash
cd /Users/harishamutha/Job-bunny-local-db
npm install                       # regenerates package-lock.json with the ui workspace
ls ui/node_modules                # watch-item probe: svelte-check AND typescript nested here
npm run ui:check                  # svelte-check: 0 errors (warnings acceptable)
npm run ui:build                  # vite build succeeds
ls ui/dist/index.html ui/dist/assets   # both exist
# Prove the lockfile is npm ci-installable BEFORE CI ever runs it (4 CI legs depend on it):
rm -rf node_modules ui/node_modules && npm ci && npm run ui:build
git status --porcelain            # ui/dist must NOT appear (gitignore works); node_modules absent
bash -c "npm run check"           # root gate untouched: 1286 tests, EXIT:0
```

- [x] **Step 11: Commit**

```bash
git add package.json package-lock.json .gitignore ui/package.json ui/tsconfig.json ui/vite.config.ts ui/index.html ui/src/main.ts ui/src/App.svelte ui/src/app.css
git commit -m "feat(ui): scaffold ui/ npm workspace (vite + svelte 5 + vitest)"
```

---

### Task 2: API contract types + fetch client + board endpoint wrappers

**Files:**
- Modify: `src/app/features/board/index.ts` (add 1 type re-export line)
- Modify: `src/app/features/profiles/index.ts` (add 1 type re-export line)
- Create: `ui/src/lib/api/types.ts`, `ui/src/lib/api/client.ts`, `ui/src/lib/api/client.test.ts`, `ui/src/features/board/api.ts`, `ui/src/features/board/api.test.ts`
- Modify: `ui/package.json` (check script gains `&& vitest run`)

**Interfaces:**
- Consumes: Task 1's workspace; the frozen src barrels.
- Produces (used by Tasks 3–6):
  - `types.ts` re-exports: `BoardDetailResponse, BoardJobDetail, BoardJobRow, BoardListResponse, BoardMetaResponse, ListQuery, TrackingPatchBody, TrackingPatchResponse, TrackingRow, BoardProfile, ProfilesResponse`.
  - `client.ts`: `class ApiError extends Error { status: number; code: string }`; `buildQuery(params: object): string`; `getJson<T>(path: string): Promise<T>`; `patchJson<T>(path: string, body: unknown): Promise<T>`.
  - `board/api.ts`: `listJobs(profile: string, query: ListQuery): Promise<BoardListResponse>`; `getJob(profile: string, id: string): Promise<BoardDetailResponse>`; `patchTracking(profile: string, id: string, patch: TrackingPatchBody): Promise<TrackingPatchResponse>`; `getMeta(profile: string): Promise<BoardMetaResponse>`.

- [x] **Step 1: src barrel re-exports (make the feature barrels the complete contract surface).** Append to `src/app/features/board/index.ts`:

```ts
export type { BoardJobDetail, BoardJobRow, TrackingRow } from '../../../ports/board.ts';
```

Append to `src/app/features/profiles/index.ts`:

```ts
export type { BoardProfile } from '../../../ports/board.ts';
```

Run `bash -c "npm run check"` — green (app→ports is allowed by `app-only-ports-core`; type-only, no behavior change, 1286 tests).

- [x] **Step 2: Write the failing tests.** `ui/src/lib/api/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildQuery, getJson, patchJson } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildQuery', () => {
  it('serializes defined params and skips undefined/empty', () => {
    expect(
      buildQuery({ status: 'Applied', company: undefined, offset: 0, sort: 'score', empty: '' }),
    ).toBe('?status=Applied&offset=0&sort=score');
  });

  it('returns empty string when nothing survives', () => {
    expect(buildQuery({ a: undefined, b: '' })).toBe('');
  });

  it('percent-encodes values', () => {
    expect(buildQuery({ company: 'a&b c' })).toBe('?company=a%26b+c');
  });
});

describe('getJson', () => {
  it('returns the parsed body on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { rows: [], total: 0 })));
    await expect(getJson('/api/x')).resolves.toEqual({ rows: [], total: 0 });
  });

  it('throws ApiError with envelope code/message on API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: { code: 'no_local_db', message: 'profile has no local database' } }),
      ),
    );
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'no_local_db' });
  });

  it('throws ApiError(code internal) when an error body is not the envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: 'internal', message: 'HTTP 500' });
  });

  it('wraps network failures as ApiError(status 0, code network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });
});

describe('patchJson', () => {
  it('sends PATCH with json content-type and body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { tracking: { jobId: 'li-1', updatedAt: 'x' } }));
    vi.stubGlobal('fetch', fetchMock);
    await patchJson('/api/x', { status: 'Applied' });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Applied' }),
    });
  });
});
```

`ui/src/features/board/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJob, getMeta, listJobs, patchTracking } from './api';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(okJson({}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('board api paths', () => {
  it('listJobs builds the jobs URL with query string', async () => {
    const fetchMock = stubFetch();
    await listJobs('rajni', { status: 'Applied', limit: 50, offset: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/profiles/rajni/jobs?status=Applied&limit=50&offset=0',
    );
  });

  it('encodes the profile and job id path segments', async () => {
    const fetchMock = stubFetch();
    await getJob('we ird', 'li-a/b');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/we%20ird/jobs/li-a%2Fb');
  });

  it('patchTracking targets the tracking route with PATCH', async () => {
    const fetchMock = stubFetch();
    await patchTracking('rajni', 'li-1', { status: 'Applied' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/jobs/li-1/tracking');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('getMeta targets the meta route', async () => {
    const fetchMock = stubFetch();
    await getMeta('rajni');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profiles/rajni/meta');
  });
});
```

- [x] **Step 3: Run to verify they fail**

```bash
npm run test --workspace ui
```

Expected: FAIL — cannot resolve `./client` / `./api`.

- [x] **Step 4: Implement.** `ui/src/lib/api/types.ts` (exact content — the ONLY file that crosses the workspace boundary; type-only, so nothing from `src/` reaches the bundle):

```ts
/**
 * The UI's single import point for backend contract types. Type-only —
 * `verbatimModuleSyntax` guarantees these erase at compile time, so no
 * `src/` code is ever bundled into the frontend.
 */
export type {
  BoardDetailResponse,
  BoardJobDetail,
  BoardJobRow,
  BoardListResponse,
  BoardMetaResponse,
  ListQuery,
  TrackingPatchBody,
  TrackingPatchResponse,
  TrackingRow,
} from '../../../../src/app/features/board/index.ts';
export type {
  BoardProfile,
  ProfilesResponse,
} from '../../../../src/app/features/profiles/index.ts';
```

`ui/src/lib/api/client.ts` (exact content):

```ts
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Serializes defined, non-empty values; returns '' or a leading-`?` string. */
export function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, 'network', err instanceof Error ? err.message : 'network error');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const envelope = body as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? 'internal',
      envelope?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

`ui/src/features/board/api.ts` (exact content):

```ts
import { buildQuery, getJson, patchJson } from '../../lib/api/client';
import type {
  BoardDetailResponse,
  BoardListResponse,
  BoardMetaResponse,
  ListQuery,
  TrackingPatchBody,
  TrackingPatchResponse,
} from '../../lib/api/types';

function profileBase(profile: string): string {
  return `/api/profiles/${encodeURIComponent(profile)}`;
}

export function listJobs(profile: string, query: ListQuery): Promise<BoardListResponse> {
  return getJson(`${profileBase(profile)}/jobs${buildQuery(query)}`);
}

export function getJob(profile: string, id: string): Promise<BoardDetailResponse> {
  return getJson(`${profileBase(profile)}/jobs/${encodeURIComponent(id)}`);
}

export function patchTracking(
  profile: string,
  id: string,
  patch: TrackingPatchBody,
): Promise<TrackingPatchResponse> {
  return patchJson(`${profileBase(profile)}/jobs/${encodeURIComponent(id)}/tracking`, patch);
}

export function getMeta(profile: string): Promise<BoardMetaResponse> {
  return getJson(`${profileBase(profile)}/meta`);
}
```

- [x] **Step 5: Enable vitest in the ui gate.** In `ui/package.json`, change the check script to:

```json
    "check": "svelte-check --tsconfig ./tsconfig.json && vitest run",
```

- [x] **Step 6: Run to verify green**

```bash
npm run test --workspace ui     # all client/api tests pass
npm run ui:check                # svelte-check 0 errors + vitest green
bash -c "npm run check"         # root: 1286 tests, EXIT:0
```

**Prove the type chase is real, not vacuous.** A silently-broken chase resolves the contract types to `any` and svelte-check stays green for the wrong reason. Temporarily append to `ui/src/lib/api/client.ts`:

```ts
import type { BoardJobRow } from './types';
const _probe: number = ({} as BoardJobRow).title; // title is string — MUST error
```

Run `npm run ui:check` — Expected: **exactly one error** (`string` not assignable to `number`). If it passes clean, the cross-boundary types degraded to `any` — report BLOCKED with the svelte-check output. Then **delete the probe lines** and re-run to green before committing.

**Watch-item:** if svelte-check reports diagnostics *inside* `src/**` files (they enter the program via the type chase), do not edit `src/**` — align `ui/tsconfig.json` compiler options with the root's strictness instead, and report what was needed.

- [x] **Step 7: Commit**

```bash
git add src/app/features/board/index.ts src/app/features/profiles/index.ts ui/src/lib/api ui/src/features/board/api.ts ui/src/features/board/api.test.ts ui/package.json
git commit -m "feat(ui): typed api client over the board contract (type-only src imports)"
```

---

### Task 3: hash router + profile store

**Files:**
- Create: `ui/src/lib/router.ts`, `ui/src/lib/router.test.ts`, `ui/src/lib/profile.ts`, `ui/src/lib/profile.test.ts`

**Interfaces:**
- Consumes: `BoardProfile` from `../lib/api/types` (Task 2).
- Produces (used by Task 4):
  - `router.ts`: `type RouteName = 'board' | 'analytics' | 'onboarding'`; `parseHash(hash: string): RouteName`; `createRouter(win): Router` where `Router = { route: Readable<RouteName>; navigate(to: RouteName): void }` and `win` needs `{ location: { hash: string }; addEventListener(type: 'hashchange', listener: () => void): void }`.
  - `profile.ts`: `createProfileStore(storage: Pick<Storage, 'getItem' | 'setItem'>): ProfileStore` where `ProfileStore = { current: Readable<string | null>; init(profiles: BoardProfile[]): void; choose(name: string): void }`. Storage key: `'jobbunny.profile'`.

- [x] **Step 1: Write the failing tests.** `ui/src/lib/router.test.ts`:

```ts
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { createRouter, parseHash } from './router';

describe('parseHash', () => {
  it.each([
    ['', 'board'],
    ['#', 'board'],
    ['#/', 'board'],
    ['#/board', 'board'],
    ['#/analytics', 'analytics'],
    ['#/onboarding', 'onboarding'],
    ['#/bogus', 'board'],
    ['#/board/extra/segments', 'board'],
  ])('maps %j to %s', (hash, expected) => {
    expect(parseHash(hash)).toBe(expected);
  });
});

function fakeWindow(initialHash: string) {
  const listeners: Array<() => void> = [];
  return {
    location: { hash: initialHash },
    addEventListener(_type: 'hashchange', listener: () => void) {
      listeners.push(listener);
    },
    fireHashChange() {
      for (const l of listeners) l();
    },
  };
}

describe('createRouter', () => {
  it('initializes from the current hash', () => {
    const win = fakeWindow('#/analytics');
    expect(get(createRouter(win).route)).toBe('analytics');
  });

  it('updates the store on hashchange', () => {
    const win = fakeWindow('');
    const router = createRouter(win);
    win.location.hash = '#/onboarding';
    win.fireHashChange();
    expect(get(router.route)).toBe('onboarding');
  });

  it('navigate writes the hash (real browsers then fire hashchange)', () => {
    const win = fakeWindow('');
    createRouter(win).navigate('analytics');
    expect(win.location.hash).toBe('#/analytics');
  });
});
```

`ui/src/lib/profile.test.ts`:

```ts
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import type { BoardProfile } from './api/types';
import { createProfileStore } from './profile';

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

function p(name: string, hasDb: boolean): BoardProfile {
  return { name, connector: 'sqlite', hasDb };
}

describe('createProfileStore', () => {
  it('init prefers the stored name when it still exists', () => {
    const store = createProfileStore(memStorage({ 'jobbunny.profile': 'beta' }));
    store.init([p('alpha', true), p('beta', false)]);
    expect(get(store.current)).toBe('beta');
  });

  it('init falls back to the first profile with a local db', () => {
    const store = createProfileStore(memStorage({ 'jobbunny.profile': 'gone' }));
    store.init([p('nodb', false), p('withdb', true)]);
    expect(get(store.current)).toBe('withdb');
  });

  it('init falls back to the first profile when none has a db', () => {
    const store = createProfileStore(memStorage());
    store.init([p('one', false), p('two', false)]);
    expect(get(store.current)).toBe('one');
  });

  it('init with no profiles yields null', () => {
    const store = createProfileStore(memStorage());
    store.init([]);
    expect(get(store.current)).toBeNull();
  });

  it('choose persists and updates', () => {
    const storage = memStorage();
    const store = createProfileStore(storage);
    store.init([p('a', true), p('b', true)]);
    store.choose('b');
    expect(get(store.current)).toBe('b');
    expect(storage.dump()).toEqual({ 'jobbunny.profile': 'b' });
  });
});
```

- [x] **Step 2: Run to verify they fail**

```bash
npm run test --workspace ui
```

Expected: FAIL — cannot resolve `./router` / `./profile`.

- [x] **Step 3: Implement.** `ui/src/lib/router.ts` (exact content):

```ts
import { type Readable, writable } from 'svelte/store';

export const ROUTES = ['board', 'analytics', 'onboarding'] as const;
export type RouteName = (typeof ROUTES)[number];

export function parseHash(hash: string): RouteName {
  const name = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  return (ROUTES as readonly string[]).includes(name) ? (name as RouteName) : 'board';
}

interface RouterWindow {
  location: { hash: string };
  addEventListener(type: 'hashchange', listener: () => void): void;
}

export interface Router {
  route: Readable<RouteName>;
  navigate(to: RouteName): void;
}

export function createRouter(win: RouterWindow): Router {
  const store = writable<RouteName>(parseHash(win.location.hash));
  win.addEventListener('hashchange', () => store.set(parseHash(win.location.hash)));
  return {
    route: { subscribe: store.subscribe },
    navigate(to) {
      win.location.hash = `#/${to}`;
    },
  };
}
```

`ui/src/lib/profile.ts` (exact content):

```ts
import { type Readable, writable } from 'svelte/store';
import type { BoardProfile } from './api/types';

const STORAGE_KEY = 'jobbunny.profile';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface ProfileStore {
  current: Readable<string | null>;
  init(profiles: BoardProfile[]): void;
  choose(name: string): void;
}

export function createProfileStore(storage: StorageLike): ProfileStore {
  const current = writable<string | null>(null);
  return {
    current: { subscribe: current.subscribe },
    init(profiles) {
      const stored = storage.getItem(STORAGE_KEY);
      const names = profiles.map((p) => p.name);
      const pick =
        stored !== null && names.includes(stored)
          ? stored
          : (profiles.find((p) => p.hasDb)?.name ?? names[0] ?? null);
      current.set(pick);
    },
    choose(name) {
      storage.setItem(STORAGE_KEY, name);
      current.set(name);
    },
  };
}
```

- [x] **Step 4: Run to verify green**

```bash
npm run test --workspace ui && npm run ui:check
```

- [x] **Step 5: Commit**

```bash
git add ui/src/lib/router.ts ui/src/lib/router.test.ts ui/src/lib/profile.ts ui/src/lib/profile.test.ts
git commit -m "feat(ui): hash router and localStorage-backed profile store"
```

---

### Task 4: app shell — sidebar, profile switcher, page outlet, global styles

**Files:**
- Modify (replace wholesale): `ui/src/App.svelte`, `ui/src/app.css`
- Create: `ui/src/features/shell/Sidebar.svelte`, `ui/src/features/shell/ProfileSwitcher.svelte`, `ui/src/features/analytics/AnalyticsPage.svelte`, `ui/src/features/onboarding/OnboardingPage.svelte`, `ui/src/features/board/BoardPage.svelte` (placeholder — replaced wholesale in Task 5)

**Interfaces:**
- Consumes: Task 2 (`getJson`, `ProfilesResponse`, `BoardProfile`), Task 3 (`createRouter`, `createProfileStore`, `RouteName`).
- Produces: the shell contract Task 5 slots into — `BoardPage` receives exactly one prop: `profile: string`. `Sidebar` props: `{ route: RouteName; navigate: (to: RouteName) => void; children?: Snippet }`. `ProfileSwitcher` props: `{ profiles: BoardProfile[]; current: string | null; choose: (name: string) => void }`.

This task has no unit tests (components are gated by `svelte-check` + `vite build`; the shell's logic lives in Task 3's tested modules). Acceptance = both green plus the placeholder page rendering.

- [x] **Step 1: `ui/src/App.svelte`** (exact content — final form, not touched by later tasks):

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { getJson } from './lib/api/client';
  import type { ProfilesResponse } from './lib/api/types';
  import { createProfileStore } from './lib/profile';
  import { createRouter } from './lib/router';
  import AnalyticsPage from './features/analytics/AnalyticsPage.svelte';
  import BoardPage from './features/board/BoardPage.svelte';
  import OnboardingPage from './features/onboarding/OnboardingPage.svelte';
  import ProfileSwitcher from './features/shell/ProfileSwitcher.svelte';
  import Sidebar from './features/shell/Sidebar.svelte';

  const router = createRouter(window);
  const route = router.route;
  const profileStore = createProfileStore(localStorage);
  const current = profileStore.current;

  let profiles = $state<ProfilesResponse['profiles']>([]);
  let loadError = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await getJson<ProfilesResponse>('/api/profiles');
      profiles = res.profiles;
      profileStore.init(res.profiles);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<div class="shell">
  <Sidebar route={$route} navigate={router.navigate}>
    <ProfileSwitcher {profiles} current={$current} choose={profileStore.choose} />
  </Sidebar>
  <main>
    {#if loadError}
      <p class="error">Could not load profiles: {loadError}</p>
    {:else if $route === 'board'}
      {#if $current}
        <BoardPage profile={$current} />
      {:else}
        <p>No profiles found — create one with the /setup wizard.</p>
      {/if}
    {:else if $route === 'analytics'}
      <AnalyticsPage />
    {:else}
      <OnboardingPage />
    {/if}
  </main>
</div>
```

- [x] **Step 2: `ui/src/features/shell/Sidebar.svelte`** (exact content):

```svelte
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { RouteName } from '../../lib/router';

  let {
    route,
    navigate,
    children,
  }: { route: RouteName; navigate: (to: RouteName) => void; children?: Snippet } = $props();

  const items: { name: RouteName; label: string }[] = [
    { name: 'board', label: 'Board' },
    { name: 'analytics', label: 'Analytics' },
    { name: 'onboarding', label: 'Onboarding' },
  ];
</script>

<aside class="sidebar">
  <div class="brand">🐇 Job Bunny</div>
  {@render children?.()}
  <nav>
    {#each items as item (item.name)}
      <button
        type="button"
        class="nav-item"
        class:active={route === item.name}
        onclick={() => navigate(item.name)}
      >
        {item.label}
      </button>
    {/each}
  </nav>
</aside>
```

- [x] **Step 3: `ui/src/features/shell/ProfileSwitcher.svelte`** (exact content):

```svelte
<script lang="ts">
  import type { BoardProfile } from '../../lib/api/types';

  let {
    profiles,
    current,
    choose,
  }: { profiles: BoardProfile[]; current: string | null; choose: (name: string) => void } =
    $props();
</script>

<label class="profile-switcher">
  <span>Profile</span>
  <select value={current ?? ''} onchange={(e) => choose(e.currentTarget.value)}>
    {#each profiles as p (p.name)}
      <option value={p.name}>{p.name}{p.hasDb ? '' : ' (no local db)'}</option>
    {/each}
  </select>
</label>
```

- [x] **Step 4: stub pages.** `ui/src/features/analytics/AnalyticsPage.svelte`:

```svelte
<section class="stub">
  <h1>Analytics</h1>
  <p>Coming soon — run stats, funnel drops, and match-quality trends will land here.</p>
</section>
```

`ui/src/features/onboarding/OnboardingPage.svelte`:

```svelte
<section class="stub">
  <h1>Onboarding</h1>
  <p>
    Coming soon — guided profile onboarding in the browser. For now, run the
    <code>/setup</code> wizard in Claude Code.
  </p>
</section>
```

Placeholder `ui/src/features/board/BoardPage.svelte` (replaced wholesale in Task 5):

```svelte
<script lang="ts">
  let { profile }: { profile: string } = $props();
</script>

<section>
  <h1>Board</h1>
  <p>Job table for “{profile}” arrives in the next task.</p>
</section>
```

- [x] **Step 5: `ui/src/app.css`** (replace wholesale — exact content; feature-specific styles stay component-scoped in Tasks 5–6):

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
  --border: light-dark(#d5d5da, #3a3a42);
  --muted: light-dark(#6b6b76, #9a9aa6);
  --bg-raised: light-dark(rgba(60, 60, 80, 0.07), rgba(200, 200, 255, 0.08));
  --danger: light-dark(#b91c1c, #f87171);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.shell {
  display: grid;
  grid-template-columns: 230px 1fr;
  min-height: 100vh;
}

.sidebar {
  border-right: 1px solid var(--border);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.brand {
  font-weight: 700;
  font-size: 1.05rem;
}

.sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-item {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}

.nav-item.active {
  background: var(--bg-raised);
  font-weight: 600;
}

main {
  padding: 1.25rem 1.5rem;
  min-width: 0;
}

.profile-switcher {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.85rem;
  color: var(--muted);
}

.profile-switcher select {
  font: inherit;
  padding: 0.35rem;
}

.error {
  color: var(--danger);
}

.stub p,
.empty {
  color: var(--muted);
}
```

- [x] **Step 6: Verify**

```bash
npm run ui:check && npm run ui:build
```

Expected: svelte-check 0 errors; build emits `ui/dist`. Optional a11y *warnings* are acceptable; errors are not.

- [x] **Step 7: Commit**

```bash
git add ui/src/App.svelte ui/src/app.css ui/src/features/shell ui/src/features/analytics ui/src/features/onboarding ui/src/features/board/BoardPage.svelte
git commit -m "feat(ui): app shell — sidebar, profile switcher, hash-routed pages"
```

---

### Task 5: board page — filter bar + job table + pagination

**Files:**
- Modify (replace wholesale): `ui/src/features/board/BoardPage.svelte`
- Create: `ui/src/features/board/FilterBar.svelte`, `ui/src/features/board/JobTable.svelte`

**Interfaces:**
- Consumes: Task 2 (`listJobs`, `getMeta`, `ApiError`, types), Task 4's shell (prop `profile: string`).
- Produces (Task 6 plugs into these exact signatures):
  - `BoardPage` internal handler `onTracking(jobId: string, tracking: TrackingRow | null): void` and state `selectedId: string | null` — Task 6 adds the `JobDrawer` block that calls them.
  - `FilterBar` props: `{ query: ListQuery; meta: BoardMetaResponse | null; onchange: (patch: Partial<ListQuery>) => void }`.
  - `JobTable` props: `{ rows: BoardJobRow[]; sort: 'date_found' | 'score'; order: 'asc' | 'desc'; onsort: (col: 'date_found' | 'score') => void; onselect: (id: string) => void }`.

- [x] **Step 1: `ui/src/features/board/BoardPage.svelte`** (exact content):

```svelte
<script lang="ts">
  import { ApiError } from '../../lib/api/client';
  import type {
    BoardListResponse,
    BoardMetaResponse,
    ListQuery,
    TrackingRow,
  } from '../../lib/api/types';
  import { getMeta, listJobs } from './api';
  import FilterBar from './FilterBar.svelte';
  import JobTable from './JobTable.svelte';

  let { profile }: { profile: string } = $props();

  let query = $state<ListQuery>({
    archived: 'false',
    sort: 'date_found',
    order: 'desc',
    limit: 50,
    offset: 0,
  });
  let data = $state<BoardListResponse | null>(null);
  let meta = $state<BoardMetaResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let noDb = $state(false);
  let selectedId = $state<string | null>(null);
  let seq = 0;

  $effect(() => {
    void loadMeta(profile);
  });

  $effect(() => {
    // Spread reads every query key synchronously so the effect re-runs on
    // any filter change (query is reassigned wholesale by patchQuery).
    void load(profile, { ...query });
  });

  async function loadMeta(name: string) {
    try {
      meta = await getMeta(name);
    } catch {
      meta = null; // option lists are cosmetic; the table still renders
    }
  }

  async function load(name: string, q: ListQuery) {
    const mine = ++seq;
    loading = true;
    try {
      const res = await listJobs(name, q);
      if (mine !== seq) return; // a newer request superseded this one
      data = res;
      error = null;
      noDb = false;
    } catch (err) {
      if (mine !== seq) return;
      data = null;
      noDb = err instanceof ApiError && err.code === 'no_local_db';
      error = noDb ? null : err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  function patchQuery(patch: Partial<ListQuery>) {
    query = { ...query, ...patch, offset: 0 };
    selectedId = null;
  }

  function toggleSort(col: 'date_found' | 'score') {
    if (query.sort === col) {
      patchQuery({ order: query.order === 'asc' ? 'desc' : 'asc' });
    } else {
      patchQuery({ sort: col, order: 'desc' });
    }
  }

  function page(delta: number) {
    const limit = query.limit ?? 50;
    query = { ...query, offset: Math.max(0, (query.offset ?? 0) + delta * limit) };
  }

  function onTracking(jobId: string, tracking: TrackingRow | null) {
    if (!data) return;
    data = {
      ...data,
      rows: data.rows.map((r) => (r.id === jobId ? { ...r, tracking } : r)),
    };
  }
</script>

<section class="board">
  <header class="board-head">
    <h1>Board</h1>
    <FilterBar {query} {meta} onchange={patchQuery} />
  </header>

  {#if noDb}
    <p class="empty">
      Profile “{profile}” has no local database yet — populate it with a pipeline run or
      <code>jobbunny migrate</code>.
    </p>
  {:else if error}
    <p class="error">Could not load jobs: {error}</p>
  {:else if data && data.rows.length === 0}
    <p class="empty">No jobs match the current filters.</p>
  {:else if data}
    <JobTable
      rows={data.rows}
      sort={query.sort ?? 'date_found'}
      order={query.order ?? 'desc'}
      onsort={toggleSort}
      onselect={(id) => (selectedId = id)}
    />
    <footer class="pager">
      <button type="button" disabled={(query.offset ?? 0) === 0} onclick={() => page(-1)}>
        Prev
      </button>
      <span>
        {(query.offset ?? 0) + 1}–{Math.min(
          (query.offset ?? 0) + (query.limit ?? 50),
          data.total,
        )} of {data.total}
      </span>
      <button
        type="button"
        disabled={(query.offset ?? 0) + (query.limit ?? 50) >= data.total}
        onclick={() => page(1)}
      >
        Next
      </button>
    </footer>
  {:else if loading}
    <p class="empty">Loading…</p>
  {/if}

  <!-- JobDrawer mounts here in the next task, driven by selectedId/onTracking. -->
</section>

<style>
  .board-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }

  .board-head h1 {
    margin: 0;
  }

  .pager {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0;
  }
</style>
```

**Implementer note:** `selectedId` and `onTracking` are intentionally written-but-unused in this task — Task 6 wires them to the drawer. Do NOT remove them, and do NOT remove the `<!-- JobDrawer mounts here… -->` comment: Task 6 replaces that exact line. Unused-symbol hints from svelte-check are warnings, not errors.

- [x] **Step 2: `ui/src/features/board/FilterBar.svelte`** (exact content):

```svelte
<script lang="ts">
  import type { BoardMetaResponse, ListQuery } from '../../lib/api/types';

  let {
    query,
    meta,
    onchange,
  }: {
    query: ListQuery;
    meta: BoardMetaResponse | null;
    onchange: (patch: Partial<ListQuery>) => void;
  } = $props();
</script>

<div class="filters">
  <select
    aria-label="Status"
    value={query.status ?? ''}
    onchange={(e) => onchange({ status: (e.currentTarget.value || undefined) as ListQuery['status'] })}
  >
    <option value="">Any status</option>
    {#each meta?.statusOptions ?? [] as s (s)}
      <option value={s}>{s}</option>
    {/each}
  </select>

  <select
    aria-label="Excitement"
    value={query.excitement ?? ''}
    onchange={(e) =>
      onchange({ excitement: (e.currentTarget.value || undefined) as ListQuery['excitement'] })}
  >
    <option value="">Any excitement</option>
    {#each meta?.excitementOptions ?? [] as x (x)}
      <option value={x}>{x}</option>
    {/each}
  </select>

  <input
    aria-label="Company"
    placeholder="Company…"
    value={query.company ?? ''}
    onchange={(e) => onchange({ company: e.currentTarget.value || undefined })}
  />

  <label>
    From
    <input
      type="date"
      value={query.dateFrom ?? ''}
      onchange={(e) => onchange({ dateFrom: e.currentTarget.value || undefined })}
    />
  </label>

  <label>
    To
    <input
      type="date"
      value={query.dateTo ?? ''}
      onchange={(e) => onchange({ dateTo: e.currentTarget.value || undefined })}
    />
  </label>

  <select
    aria-label="Archived"
    value={query.archived ?? 'false'}
    onchange={(e) => onchange({ archived: e.currentTarget.value as 'true' | 'false' })}
  >
    <option value="false">Active</option>
    <option value="true">Archived</option>
  </select>
</div>

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .filters select,
  .filters input {
    font: inherit;
    padding: 0.3rem 0.4rem;
  }

  .filters label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
</style>
```

Archived semantics (from the PR-4 adapter, see Global Constraints): two-state, never "all" — the adapter always emits `jobs.archived = ?` with absent coerced to `false`. Hence an Active/Archived select, not an "include archived" checkbox. (For the other filters, `{ status: undefined }` etc. in a spread DOES override the old value — `patchQuery` relies on that to clear a filter.)

- [x] **Step 3: `ui/src/features/board/JobTable.svelte`** (exact content):

```svelte
<script lang="ts">
  import type { BoardJobRow } from '../../lib/api/types';

  let {
    rows,
    sort,
    order,
    onsort,
    onselect,
  }: {
    rows: BoardJobRow[];
    sort: 'date_found' | 'score';
    order: 'asc' | 'desc';
    onsort: (col: 'date_found' | 'score') => void;
    onselect: (id: string) => void;
  } = $props();

  function arrow(col: 'date_found' | 'score'): string {
    if (col !== sort) return '';
    return order === 'asc' ? ' ↑' : ' ↓';
  }
</script>

<table class="jobs">
  <thead>
    <tr>
      <th><button type="button" onclick={() => onsort('date_found')}>Found{arrow('date_found')}</button></th>
      <th>Title</th>
      <th>Company</th>
      <th>Location</th>
      <th><button type="button" onclick={() => onsort('score')}>Score{arrow('score')}</button></th>
      <th>Excitement</th>
      <th>Status</th>
      <th>Flags</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.id)}
      <tr class:archived={row.archived}>
        <td>{row.dateFound.slice(0, 10)}</td>
        <td class="title">
          <button type="button" class="link" onclick={() => onselect(row.id)}>{row.title}</button>
        </td>
        <td>{row.company}</td>
        <td>{row.locationCity ?? '—'}{row.workType ? ` · ${row.workType}` : ''}</td>
        <td class="num">{row.score ?? '—'}</td>
        <td>{row.excitement ?? '—'}</td>
        <td>{row.tracking?.status ?? '—'}</td>
        <td>{row.reviewFlags.length > 0 ? `⚑ ${row.reviewFlags.length}` : ''}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .jobs {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  .jobs th,
  .jobs td {
    text-align: left;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .jobs td.title {
    white-space: normal;
  }

  .jobs th button {
    font: inherit;
    font-weight: 600;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
  }

  .jobs .num {
    text-align: right;
  }

  .link {
    font: inherit;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  tr.archived {
    opacity: 0.55;
  }
</style>
```

(Row selection is a real `<button>` in the title cell — keyboard-accessible, no `onclick`-on-`<tr>` a11y warnings.)

- [x] **Step 4: Verify**

```bash
npm run ui:check && npm run ui:build
```

Expected: svelte-check 0 errors, build green. Vitest suite unchanged-green.

- [x] **Step 5: Commit**

```bash
git add ui/src/features/board/BoardPage.svelte ui/src/features/board/FilterBar.svelte ui/src/features/board/JobTable.svelte
git commit -m "feat(ui): board page — filterable, sortable, paginated job table"
```

---

### Task 6: detail drawer + inline tracking edits (optimistic PATCH + rollback)

**Files:**
- Create: `ui/src/features/board/tracking.ts`, `ui/src/features/board/tracking.test.ts`, `ui/src/features/board/JobDrawer.svelte`, `ui/src/features/board/TrackingForm.svelte`
- Modify: `ui/src/features/board/BoardPage.svelte` (add drawer import + mount block only)

**Interfaces:**
- Consumes: Task 2 (`getJob`, `patchTracking`, types), Task 5's `selectedId`/`onTracking(jobId, tracking)`.
- Produces:
  - `tracking.ts`: `applyPatch(existing: TrackingRow | null, jobId: string, patch: TrackingPatchBody): TrackingRow` — pure; `null` field deletes, absent keeps, value overwrites; never mutates input; `updatedAt` of a fresh row is `''` (server truth replaces it on success).
  - `JobDrawer` props: `{ profile: string; jobId: string; statusOptions: string[]; onclose: () => void; ontracking: (jobId: string, tracking: TrackingRow | null) => void }`.
  - `TrackingForm` props: `{ profile: string; jobId: string; tracking: TrackingRow | null; statusOptions: string[]; ontracking: (jobId: string, tracking: TrackingRow | null) => void }`.

- [x] **Step 1: Write the failing test.** `ui/src/features/board/tracking.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TrackingRow } from '../../lib/api/types';
import { applyPatch } from './tracking';

const existing: TrackingRow = {
  jobId: 'li-1',
  updatedAt: '2026-08-01T10:00:00.000Z',
  status: 'Applied',
  notes: 'phone screen booked',
};

describe('applyPatch', () => {
  it('creates a fresh row from null with empty updatedAt', () => {
    expect(applyPatch(null, 'li-9', { status: 'Lead' })).toEqual({
      jobId: 'li-9',
      updatedAt: '',
      status: 'Lead',
    });
  });

  it('overwrites patched fields and keeps the rest', () => {
    const next = applyPatch(existing, 'li-1', { status: 'Onsite' });
    expect(next).toEqual({ ...existing, status: 'Onsite' });
  });

  it('null clears a field entirely', () => {
    const next = applyPatch(existing, 'li-1', { notes: null });
    expect(next).toEqual({
      jobId: 'li-1',
      updatedAt: '2026-08-01T10:00:00.000Z',
      status: 'Applied',
    });
    expect('notes' in next).toBe(false);
  });

  it('does not mutate the input row', () => {
    applyPatch(existing, 'li-1', { status: 'Rejected', notes: null });
    expect(existing.status).toBe('Applied');
    expect(existing.notes).toBe('phone screen booked');
  });
});
```

- [x] **Step 2: Run to verify it fails**

```bash
npm run test --workspace ui
```

Expected: FAIL — cannot resolve `./tracking`.

- [x] **Step 3: Implement `ui/src/features/board/tracking.ts`** (exact content):

```ts
import type { TrackingPatchBody, TrackingRow } from '../../lib/api/types';

/**
 * Local mirror of the server's tracking-patch semantics (ports/board.ts):
 * a null field clears it, an absent field keeps it, a value overwrites it.
 * Used for the optimistic update; the server's TrackingRow replaces this
 * on success, and the pre-patch snapshot restores it on failure.
 */
export function applyPatch(
  existing: TrackingRow | null,
  jobId: string,
  patch: TrackingPatchBody,
): TrackingRow {
  const base: TrackingRow = existing ?? { jobId, updatedAt: '' };
  // Field-level merge over an index-typed copy: TrackingPatchBody's keys are
  // a subset of TrackingRow's, but TS cannot correlate the two per-key.
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as unknown as TrackingRow;
}
```

- [x] **Step 4: Run to verify green**

```bash
npm run test --workspace ui
```

- [x] **Step 5: `ui/src/features/board/TrackingForm.svelte`** (exact content):

```svelte
<script lang="ts">
  import type { TrackingPatchBody, TrackingRow } from '../../lib/api/types';
  import { patchTracking } from './api';
  import { applyPatch } from './tracking';

  let {
    profile,
    jobId,
    tracking,
    statusOptions,
    ontracking,
  }: {
    profile: string;
    jobId: string;
    tracking: TrackingRow | null;
    statusOptions: string[];
    ontracking: (jobId: string, tracking: TrackingRow | null) => void;
  } = $props();

  let saving = $state(false);
  let saveError = $state<string | null>(null);

  async function commit(field: keyof TrackingPatchBody, raw: string) {
    const previous = tracking?.[field] ?? '';
    if (raw === previous || (raw.trim() === '' && previous === '')) return; // no-op edit
    // Cast erases the status literal union — safe here because the select's
    // options come from /meta (the server vocab), and the server rejects
    // anything else with a 400 that rolls back below.
    const patch = { [field]: raw.trim() === '' ? null : raw } as TrackingPatchBody;
    const snapshot = tracking;
    ontracking(jobId, applyPatch(tracking, jobId, patch)); // optimistic
    saving = true;
    saveError = null;
    try {
      const res = await patchTracking(profile, jobId, patch);
      ontracking(jobId, res.tracking); // server truth (real updatedAt)
    } catch (err) {
      ontracking(jobId, snapshot); // rollback
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<form class="tracking" onsubmit={(e) => e.preventDefault()}>
  <h3>Tracking {#if saving}<span class="saving">saving…</span>{/if}</h3>
  {#if saveError}
    <p class="error">Save failed — rolled back: {saveError}</p>
  {/if}

  <label>
    Status
    <select
      value={tracking?.status ?? ''}
      onchange={(e) => commit('status', e.currentTarget.value)}
    >
      <option value="">—</option>
      {#each statusOptions as s (s)}
        <option value={s}>{s}</option>
      {/each}
    </select>
  </label>

  <label>
    Date applied
    <input
      type="date"
      value={tracking?.dateApplied ?? ''}
      onchange={(e) => commit('dateApplied', e.currentTarget.value)}
    />
  </label>

  <label>
    Comp range
    <input
      value={tracking?.compRange ?? ''}
      onchange={(e) => commit('compRange', e.currentTarget.value)}
    />
  </label>

  <label>
    Contact
    <input
      value={tracking?.contact ?? ''}
      onchange={(e) => commit('contact', e.currentTarget.value)}
    />
  </label>

  <label>
    Next action
    <input
      value={tracking?.nextAction ?? ''}
      onchange={(e) => commit('nextAction', e.currentTarget.value)}
    />
  </label>

  <label>
    Next action date
    <input
      type="date"
      value={tracking?.nextActionDate ?? ''}
      onchange={(e) => commit('nextActionDate', e.currentTarget.value)}
    />
  </label>

  <label>
    Notes
    <textarea
      rows="3"
      value={tracking?.notes ?? ''}
      onchange={(e) => commit('notes', e.currentTarget.value)}
    ></textarea>
  </label>
</form>

<style>
  .tracking {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem 0.8rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    margin: 1rem 0;
  }

  .tracking h3 {
    grid-column: 1 / -1;
    margin: 0;
  }

  .tracking .saving {
    font-size: 0.8rem;
    font-weight: 400;
    color: var(--muted);
  }

  .tracking label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .tracking label:has(textarea) {
    grid-column: 1 / -1;
  }

  .tracking select,
  .tracking input,
  .tracking textarea {
    font: inherit;
    color: inherit;
    padding: 0.3rem 0.4rem;
  }

  .tracking .error {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 0.85rem;
  }
</style>
```

An invalid inline edit (e.g. a status string the server's `z.strictObject` rejects — unreachable through the select, but reachable for dates) comes back as a 400 `validation` envelope → rollback + the message shown. That's the required "optimistic update + rollback on failure".

- [x] **Step 6: `ui/src/features/board/JobDrawer.svelte`** (exact content):

```svelte
<script lang="ts">
  import { ApiError } from '../../lib/api/client';
  import type { BoardDetailResponse, TrackingRow } from '../../lib/api/types';
  import { getJob } from './api';
  import TrackingForm from './TrackingForm.svelte';

  let {
    profile,
    jobId,
    statusOptions,
    onclose,
    ontracking,
  }: {
    profile: string;
    jobId: string;
    statusOptions: string[];
    onclose: () => void;
    ontracking: (jobId: string, tracking: TrackingRow | null) => void;
  } = $props();

  let detail = $state<BoardDetailResponse | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void load(profile, jobId);
  });

  async function load(name: string, id: string) {
    detail = null;
    error = null;
    try {
      detail = await getJob(name, id);
    } catch (err) {
      error =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
    }
  }

  function handleTracking(id: string, tracking: TrackingRow | null) {
    if (detail && detail.id === id) detail = { ...detail, tracking };
    ontracking(id, tracking);
  }
</script>

<aside class="drawer">
  <button type="button" class="close" onclick={onclose} aria-label="Close">×</button>
  {#if error}
    <p class="error">{error}</p>
  {:else if !detail}
    <p class="empty">Loading…</p>
  {:else}
    <h2>{detail.title}</h2>
    <p class="company">
      {detail.company} ·
      <a href={detail.url} target="_blank" rel="noreferrer">posting ↗</a>
    </p>
    <dl class="meta">
      <dt>Found</dt>
      <dd>{detail.dateFound.slice(0, 10)}</dd>
      <dt>Location</dt>
      <dd>{detail.locationCity ?? '—'}{detail.workType ? ` · ${detail.workType}` : ''}</dd>
      <dt>Score</dt>
      <dd>{detail.score ?? '—'}</dd>
      <dt>Excitement</dt>
      <dd>{detail.excitement ?? '—'}</dd>
      {#if detail.skills.length > 0}
        <dt>Skills</dt>
        <dd>{detail.skills.join(', ')}</dd>
      {/if}
      {#if detail.matchReasons.length > 0}
        <dt>Match</dt>
        <dd>{detail.matchReasons.join('; ')}</dd>
      {/if}
      {#if detail.reviewFlags.length > 0}
        <dt>Flags</dt>
        <dd>⚑ {detail.reviewFlags.join('; ')}</dd>
      {/if}
    </dl>

    <TrackingForm
      {profile}
      jobId={detail.id}
      tracking={detail.tracking}
      {statusOptions}
      ontracking={handleTracking}
    />

    {#if detail.jd.content?.rawText}
      <h3>Job description</h3>
      <pre class="jd">{detail.jd.content.rawText}</pre>
    {/if}
  {/if}
</aside>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 90vw);
    overflow-y: auto;
    background: Canvas;
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15);
    padding: 1rem 1.25rem;
    z-index: 10;
  }

  .close {
    position: absolute;
    top: 0.6rem;
    right: 0.8rem;
    font-size: 1.4rem;
    border: none;
    background: none;
    cursor: pointer;
  }

  .drawer h2 {
    margin: 0.25rem 0 0.25rem;
    padding-right: 2rem;
  }

  .company {
    color: var(--muted);
    margin-top: 0;
  }

  .meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.9rem;
    font-size: 0.88rem;
  }

  .meta dt {
    color: var(--muted);
  }

  .meta dd {
    margin: 0;
  }

  .jd {
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.45;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
</style>
```

- [x] **Step 7: Mount the drawer.** In `ui/src/features/board/BoardPage.svelte`, add to the imports:

```ts
  import JobDrawer from './JobDrawer.svelte';
```

and replace the closing comment line `<!-- JobDrawer mounts here in the next task, driven by selectedId/onTracking. -->` with:

```svelte
  {#if selectedId}
    <JobDrawer
      {profile}
      jobId={selectedId}
      statusOptions={meta?.statusOptions ?? []}
      onclose={() => (selectedId = null)}
      ontracking={onTracking}
    />
  {/if}
```

- [x] **Step 8: Verify**

```bash
npm run ui:check && npm run ui:build
```

Expected: svelte-check 0 errors, vitest green (client + api + router + profile + tracking suites), build green.

- [x] **Step 9: Commit**

```bash
git add ui/src/features/board
git commit -m "feat(ui): job detail drawer with optimistic tracking edits + rollback"
```

---

### Task 7: src-side polish — no-UI message + CI ui job

**Files:**
- Modify: `src/app/server/static.ts` (NO_UI_MESSAGE), `src/app/server/static.test.ts:94` (expectation)
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: Task 1's root scripts (`ui:check`, `ui:build`).
- Produces: nothing downstream — closure-only hygiene.

- [x] **Step 1: Update the test first.** In `src/app/server/static.test.ts` (the expectation string around line 94), change the fragment `'(arrives with PR 5). API: GET /api/profiles'` so the full expected message reads exactly:

```
Job Bunny board API is running. UI not built yet — run: npm run ui:build. API: GET /api/profiles
```

Run: `node --test src/app/server/static.test.ts` — Expected: FAIL (message mismatch).

- [x] **Step 2: Update the implementation.** In `src/app/server/static.ts:14-16` replace:

```ts
const NO_UI_MESSAGE =
  'Job Bunny board API is running. UI not built yet — ' +
  'run: npm run ui:build (arrives with PR 5). API: GET /api/profiles';
```

with:

```ts
const NO_UI_MESSAGE =
  'Job Bunny board API is running. UI not built yet — ' +
  'run: npm run ui:build. API: GET /api/profiles';
```

In the same file, the header comment (around line 2) still says the UI "arrives PR 5" — update that phrase to reflect that `ui/dist` now exists and is built via `npm run ui:build` (comment-only, keep the rest of the header intact).

Run: `node --test src/app/server/static.test.ts` — Expected: PASS.

- [x] **Step 3: CI.** In `.github/workflows/test.yml`, insert a `ui` job between `check` and `test`, and extend the wrapper. The file's `check` job is untouched. New `ui` job (exact text, same indentation style as `check`):

```yaml
  # The UI workspace has its own gate (svelte-check + vitest + vite build).
  # One OS is enough — it produces a platform-independent static bundle.
  ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
        env:
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
      - run: npm run ui:check
      - run: npm run ui:build
```

And the `test` wrapper becomes (only `needs` and the failure condition change; the comment stays):

```yaml
  test:
    if: always()
    needs: [check, ui]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
      - if: needs.check.result != 'success' || needs.ui.result != 'success'
        run: exit 1
```

- [x] **Step 4: Verify + commit**

```bash
bash -c "npm run check"    # root gate green (same count as baseline — no new tests)
git add src/app/server/static.ts src/app/server/static.test.ts .github/workflows/test.yml
git commit -m "chore(app,ci): drop PR-5 placeholder from no-UI message; add ui CI job"
```

---

### Task 8: local-first setup — Notion-conditional token step, ui-build step, wizard rewrite

**Files:**
- Modify: `src/cli/commands/setup.ts`
- Modify: `src/cli/commands/setup.test.ts`
- Modify: `src/cli/commands/profile.ts` (SEARCH_URLS_TEMPLATE `.md` → `.json` mention only) and `src/cli/commands/lane_add_url.ts` (the `<!-- inventory: … -->` comment it writes, `.md` → `.json`) — plus any tests pinning those exact strings (grep `page_inventory` across `src/cli/commands/*.test.ts`)
- Modify: `.claude/commands/setup.md` (full replacement — text below; **user-approved 2026-08-01**: "fold the /setup sqlite-only branch into PR 5")

**Interfaces:**
- Consumes: `ProfileFsDeps` (`root, exists, readFile, writeFile, mkdir, write`) from `./profile.ts` — unchanged; the sqlite scaffold default (`connector: "sqlite"`) from PR 4.
- Produces: `jobbunny setup` step list becomes: `profile scaffold`, `.env NOTION_TOKEN` (now conditional), `resume.json`, `search_urls.md`, `page_inventory coverage` (now checks `.json`), **new** `ui build`. Exit semantics unchanged (0 iff no `needs-action`).

Three behavior changes, each pinned by a test written first:
1. **`.env NOTION_TOKEN` is checked only when the profile actually uses Notion.** The condition mirrors the real mirror authority (`cli/wire/builders.ts` `mirrorSettings()`: sqlite + `mirror === true` + non-empty `dbId` — `compose.test.ts` pins `{mirror: true}` without a `dbId` as *no mirror*): token needed iff `connector === 'notion'`, OR (`settings.notion.mirror === true` AND `settings.notion.dbId` is a non-empty string). Everything else → `skipped`.
2. **New `ui build` step**: `done` when `<root>/ui/dist/index.html` exists, else `needs-action — run: npm run ui:build`.
3. **Authority fix (pre-existing, verified in design review):** `stepInventory` checks `page_inventory/<page>.md`, but the runtime authority is `<page>.json` (`src/adapters/lanes/linkedin/inventory.ts:30` — the lane loads only `.json`). Both files happen to exist today, so setup currently reports `done` off a NON-authoritative file — a stale `.md` beside a missing `.json` would pass setup and then fail the run. Fix setup to `.json`, and fix the two places that steer users toward `.md`: `profile.ts` SEARCH_URLS_TEMPLATE and the `<!-- inventory: … -->` comment `lane_add_url.ts` writes into `search_urls.md`.

- [x] **Step 1: Write the failing tests.** Extend `src/cli/commands/setup.test.ts` (follow its existing temp-dir/fake-deps helper pattern; the cases below are the required semantics — adapt helper names to the file's existing ones):

```ts
test('sqlite-only profile: .env NOTION_TOKEN is skipped even with no .env', async (t) => {
  // fresh temp root, NO .env file; scaffold runs inside setupCommand and
  // seeds profile.json with connector "sqlite" (the PR-4 default)
  const { deps, lines } = makeDeps(t); // existing helper
  const code = await setupCommand({ profile: 'zz' }, deps);
  const tokenLine = lines.find((l) => l.includes('.env NOTION_TOKEN'));
  assert.match(tokenLine ?? '', /skipped — local sqlite profile/);
  // exit code may still be 1 (resume.json etc. need action) — token must not be the cause
});

test('connector "notion" still requires the token', async (t) => {
  // pre-write profiles/zz/profile.json with {"connector":"notion",...} before running
  // no .env → needs-action
  assert.match(tokenLine ?? '', /needs-action/);
});

test('sqlite profile with settings.notion.mirror=true AND a dbId requires the token', async (t) => {
  // pre-write profile.json: connector "sqlite", settings.notion = { dbId: "x", mirror: true }
  // no .env → needs-action; with NOTION_TOKEN=abc in .env → done
});

test('mirror=true WITHOUT a dbId does not require the token (matches mirrorSettings())', async (t) => {
  // pre-write profile.json: connector "sqlite", settings.notion = { mirror: true }
  // compose.test.ts pins this slice as no-mirror — token step must be skipped
  assert.match(tokenLine ?? '', /skipped/);
});

test('unparseable profile.json makes the token step needs-action, not a crash', async (t) => {
  // pre-write profiles/zz/profile.json containing "{nope"
  assert.match(tokenLine ?? '', /needs-action — profile\.json is not valid JSON/);
});

test('ui build: needs-action without ui/dist, done with it', async (t) => {
  // run once → expect "[setup] ui build: needs-action — board UI not built — run: npm run ui:build"
  // then create <root>/ui/dist/index.html in the temp root and run again → "done — ui/dist present"
});

test('page_inventory coverage accepts .json inventory files', async (t) => {
  // seed search_urls.md with a "### search-results" section + one URL bullet,
  // create <root>/src/adapters/lanes/linkedin/page_inventory/search-results.json
  // → expect "page_inventory coverage: done"
  // (pins the .md→.json bugfix — with .md-only lookup this reports missing)
});
```

**Four existing tests in `setup.test.ts` WILL break — update them deliberately (do not weaken the new semantics to appease them):**
1. The empty-root test (~L34) asserting `'.env NOTION_TOKEN: needs-action'` — the scaffolded profile is sqlite now → expectation becomes `skipped`, OR pre-write a `{"connector":"notion"}` profile.json to keep exercising the needs-action path.
2. `'never prints or leaks the NOTION_TOKEN value'` (~L80) asserting `'.env NOTION_TOKEN: done'` — same cause; pre-write a notion profile.json so the token path still runs (the leak assertion is the point of that test — keep it exercised).
3. `'.env present but NOTION_TOKEN empty is needs-action'` (~L93) — same: pre-write a notion profile.json.
4. `'fully satisfied profile … exits 0'` (~L41) breaks twice: its fixture writes `linkedin__jobs-search.md` (switch to `.json`) AND the new `ui build` step is `needs-action` in a temp root — create `<root>/ui/dist/index.html` in the fixture. Also scan the `'never mutates outside profiles/<p>/'` test (~L149) for an exit-code assertion that the new step could flip.

Line numbers are approximate — locate each by its test name.

- [x] **Step 2: Run to verify the new tests fail**

```bash
node --test src/cli/commands/setup.test.ts
```

Expected: FAIL on each new case (token step unconditional today; no `ui build` step; `.md` lookup).

- [x] **Step 3: Implement in `src/cli/commands/setup.ts`.**

(a) New helper after `envHasKey`:

```ts
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
      notion?.mirror === true && typeof notion.dbId === 'string' && notion.dbId.length > 0;
    return {
      notionNeeded: parsed.connector === 'notion' || mirrorActive,
      problem: null,
    };
  } catch {
    return { notionNeeded: false, problem: 'profile.json is not valid JSON' };
  }
}
```

(b) `stepNotionToken` gains a `profileDir` parameter and the gate (existing body preserved for the notion path):

```ts
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
```

(c) In `stepInventory`, change `` `${page}.md` `` to `` `${page}.json` `` (the runtime authority — `inventory.ts:30`). In the same commit, update the three other `.md` sites to `.json`: the `page_inventory/<page>.md` phrase inside `SEARCH_URLS_TEMPLATE` in `src/cli/commands/profile.ts` (~L68); and in `src/cli/commands/lane_add_url.ts` BOTH the `<!-- inventory: …/<page>.md -->` comment string (~L132) AND the `${page}.md` in the inventory-existence check's `path.join` (~L158) — that check drives the "no inventory yet — run /page-analyse" warn and currently consults the non-authoritative file too. Grep `page_inventory` across `src/cli/commands/*.test.ts` and update every test pinning those exact strings (known pins: `lane_add_url.test.ts` ~L152 regex + ~L175 fixture file, `setup.test.ts` ~L51/62/107 fixture strings — the Step 1 rewrite already covers setup's).

(d) New step before the final loop:

```ts
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
```

(e) In `setupCommand`, update the call site and append the step:

```ts
  steps.push(await stepScaffold(profileDir, resolved));
  steps.push(await stepNotionToken(resolved.root, profileDir, resolved));
  steps.push(await stepResume(profileDir, resolved));
  const { result: searchUrlsResult, text } = await stepSearchUrls(profileDir, resolved);
  steps.push(searchUrlsResult);
  steps.push(await stepInventory(resolved.root, text, resolved));
  steps.push(await stepUiBuilt(resolved.root, resolved));
```

Also refresh the file-header comment (the step list it describes) to match. Keep `setup.ts` under the 400-line cap (currently 196 — comfortably fits).

- [x] **Step 4: Run to verify green**

```bash
node --test src/cli/commands/setup.test.ts   # all cases pass
bash -c "npm run check"                       # full gate green (count grows by the new tests)
```

- [x] **Step 5: Replace `.claude/commands/setup.md` with exactly this content** (user-approved fold-in; frontmatter unchanged):

```markdown
---
description: Onboarding wizard — one command from a fresh clone to a running profile. Idempotent, resumable at any step.
---

`$ARGUMENTS` = profile name (lowercase letters, digits, hyphens — e.g. `harish`). Walk through every step below in order, in this one invocation — don't stop halfway and leave the rest as homework. Re-running later is always safe: every step is check-before-act and skips what's already done. `jobbunny setup --profile <p>` (`src/cli/commands/setup.ts`) covers only the non-interactive spine (scaffold + status checks) — the mode question, the Notion wiring (mirror mode only), and the secrets prompt below are done by you (Claude), not by that command.

**0. Mode — one question before anything else.** New profiles are **local-first**: jobs land in `profiles/<profile>/data/jobbunny.db` (SQLite) and are browsed with `jobbunny board` — no Notion account needed. Ask exactly one question: *"Local-only (default), or also mirror each run into a Notion database?"*
  - **Local-only** → skip steps 3–4 entirely. No token, no Notion pages, nothing to collect.
  - **Notion mirror** → collect the two one-time Notion prerequisites now:
    - **Integration token.** notion.so/my-integrations → New integration → copy the "Internal Integration Token". Pasted into a masked prompt in step 3 — never typed in chat.
    - **Shared root page.** In Notion, create a page titled exactly `Job Bunny's List` (byte-exact) and share it with the integration (··· menu → Connections → add the integration). (If they already have another Job Bunny profile, these likely already exist — ask first.)

**1. Dependencies.**
Node ≥ 24 is required (v2 runs TypeScript natively, no build step); the machine default is 24 and `.nvmrc` pins the repo, so this is normally a no-op — if `node -v` ever shows < 24, run `source ~/.nvm/nvm.sh && nvm use 24`. If `node_modules/` is missing (fresh clone), run `npm install` first. If step 2 reports `ui build: needs-action`, run `npm run ui:build` yourself (builds the job-board UI into `ui/dist/`; takes a minute the first time).

**2. Scaffold + status check.**
```bash
node src/cli/main.ts setup --profile <profile>
```
Idempotent: creates `profiles/<profile>/` and seeds any missing `profile.json` / `filter.json` / `search_urls.md` / `avoid.md` (never clobbers an existing file; new profiles scaffold local-first with `"connector": "sqlite"`), then reports `done` / `skipped` / `needs-action` per step (`.env` NOTION_TOKEN — automatically skipped for local-only profiles, `resume.json`, `search_urls.md`, page-inventory coverage, ui build). Exit code is 0 iff every step is done-or-skipped. Surface its output verbatim — this is what tells you what's still needed below.

**3. Notion token — mirror mode only.** (Local-only: skip.) If step 2 reported `.env NOTION_TOKEN: needs-action`, ask for the token from step 0 (masked) and append `NOTION_TOKEN=<token>` to `.env` yourself (create `.env` from `.env.example` if it doesn't exist yet).

**4. Notion DB — mirror mode only: adopt or create.** (Local-only: skip.) Using Notion MCP tools, find or create the profile's own page (a child of "Job Bunny's List") with a "Job Bunny — Jobs" database inside it. If "Could not find a page titled..." — the step-0 page isn't actually shared with the integration yet; point the user back there. Once you have the database id, write it into `profiles/<profile>/profile.json`: `settings.notion.dbId` and `settings.notion.mirror: true` — and **leave `connector: "sqlite"`**: the local DB stays the source of truth; each run pushes a best-effort copy to Notion, and a Notion outage can never fail a run. `settings.notion.dryRun` defaults `true` — leave it there for a fresh profile. (A full-Notion profile — `connector: "notion"`, no local DB — remains supported for existing setups but is no longer what this wizard creates.)

**5. Résumé — parse it, don't hand it to the user as homework.** Ask for a resume: a file path (PDF or plain text) or pasted text. Read it directly (the Read tool handles PDFs) and extract these fields yourself into `profiles/<profile>/resume.json` (there is no template to overwrite — v2 doesn't seed this file, `setup` just checks it exists):
  - `current_yoe` (number), `target_seniority` (array, e.g. `["Staff","Lead"]`), `core_skills` / `secondary_skills` (arrays), `domain_experience` (array), `usp` (array, 1-2 short differentiator lines).
  - `preferred_work_type` and `location` are rarely reliable from a resume — ask for both together in one follow-up question. `location` accepts a string or array of strings.
  Show a compact summary and get one confirmation before proceeding. Hand-editing `resume.json` directly is still supported if the user prefers it. (This is the one-time PDF→JSON seed CLAUDE.md allows — `resume.json` is the only résumé source v2 reads; there is no `resume_meta.json` derivation step anymore.)

**6. Title filter — derive it, don't dump JSON on the user.** Edit `profiles/<profile>/filter.json`'s `title` block yourself (`FilterConfigSchema`, `src/core/filter/config.ts`): `title.domain` / `title.function` / `title.seniority`, each a `{ match: [...], reject: [...], severity: "hard"|"soft" }` rule, derived from the target roles/domain gathered in step 5. Show the resulting block and get one confirmation — a mismatch here doesn't error, it silently drops (hard) or penalizes (soft) every non-matching job.

**7. Geo filter — derive it, don't dump JSON on the user.** Edit `filter.json`'s `locations[]` yourself: one entry per home city with `city`, `country`, and `workTypes` (`["onsite","hybrid","remote"]` subset) — this is now the sole home-geo source (no more `resume_meta.json` location lookup). If the candidate takes remote roles in specific timezones, set `timezones.accept` (e.g. `["APAC","EMEA"]`) and `timezones.severity`. Show the resulting block and get one confirmation — a mismatch here silently drops or penalizes every job at that location.

**8. First search URL.** Ask for one LinkedIn saved-search URL and a short label, then run `node src/cli/main.ts lane add-url "<url>" "<label>" --profile <profile>`. More can be added later the same way. Confirm a `src/adapters/lanes/linkedin/page_inventory/<page>.json` exists for its page-type (run `/page-analyse <page-slug>` if not).

**9. Notifications.** One yes/no: want a Telegram run digest? If yes, walk the README's "Telegram digest" section with the user yourself: `TELEGRAM_BOT_TOKEN` from @BotFather into `.env` (masked, same handling as step 3), get the numeric `chat_id`, then add `"telegram"` to `notifiers` and `settings.telegram.chatId` (a number, not a string) in `profile.json`. If no, skip.

**10. Verify.** Finish by running `node src/cli/main.ts doctor --profile <profile>` yourself and reporting its actual pass/fail output. A red Chrome/CDP check at this point is expected if they haven't logged into LinkedIn in `.chrome-debug/` yet; say so rather than treating it as a setup failure. Then show the board once: run `node src/cli/main.ts board` and point the user at `http://127.0.0.1:4646` — the job table stays empty until the first pipeline run fills the local DB.

Report a short summary at the end: what's done, what's still red (if anything), and the one-line next action (usually `node src/cli/main.ts run --profile <profile>`).
```

- [x] **Step 6: Final verify + commit**

```bash
bash -c "npm run check"
git add src/cli/commands/setup.ts src/cli/commands/setup.test.ts src/cli/commands/profile.ts src/cli/commands/lane_add_url.ts .claude/commands/setup.md
# plus any *.test.ts updated for the .md→.json string pins
git commit -m "feat(cli): local-first setup — Notion token only when needed, ui-build check, .json inventory authority"
```

---

### Task 9: runtime verification (throwaway profile only)

**Files:** none committed.

Never touch `profiles/harish/**` or `profiles/rajni/**`; PATCH only the throwaway profile. All commands from `/Users/harishamutha/Job-bunny-local-db`.

- [x] **Step 1:** `bash -c "npm run check"` green at HEAD; `npm run ui:check` green; `npm run ui:build` fresh (note: `ui/dist` is gitignored — `git status --porcelain` stays clean).

- [x] **Step 2: Seed a sqlite profile with one job.**

```bash
node src/cli/main.ts profile build --profile zzuicheck
cat profiles/zzuicheck/profile.json    # confirm "connector": "sqlite" (PR-4 scaffold default)
mkdir -p "profiles/zzuicheck/data/runs/$(date -u +%F)/09-00"
cat > "profiles/zzuicheck/data/runs/$(date -u +%F)/09-00/08-rank.json" <<'EOF'
{"jobs":[{"identity":{"id":"li-ui-1","lane":"linkedin","url":"https://example.com/j/1","company":"Acme","title":"Staff Engineer","scrapedAt":"2026-08-02T09:00:00.000Z"},"content":{"rawText":"synthetic staff engineer JD for board verification"}}],"dropped":[]}
EOF
env -u NOTION_TOKEN node src/cli/main.ts stage sync --profile zzuicheck
```

Expected: exit 0, `sync: 1 -> 1` (the checkpoint filename `08-rank.json` + UTC date matches what `stage` reads — the exact procedure PR 4's Task 10 verified at `64be887`).

- [x] **Step 3: Setup smoke (Task 8 live).**

```bash
node src/cli/main.ts setup --profile zzuicheck; echo "EXIT:$?"
```

Expected: `.env NOTION_TOKEN: skipped — local sqlite profile — Notion token not needed` (skipped because the profile is sqlite-only — the env var is irrelevant to this step, which reads `.env` from disk); `ui build: done — ui/dist present`. (Exit is 1 — `resume.json`/`search_urls.md` legitimately need action; that's correct behavior, not a failure.)

- [x] **Step 4: Board serves the built UI.**

```bash
env -u NOTION_TOKEN node src/cli/main.ts board --port 4747 & echo $! > "${TMPDIR:-/tmp}/jb-board.pid"
sleep 1
curl -s http://127.0.0.1:4747/ | head -5                       # index.html: contains <div id="app"> and a /assets/*.js script tag
ASSET=$(curl -s http://127.0.0.1:4747/ | grep -o '/assets/[^"]*\.js' | head -1)
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "http://127.0.0.1:4747$ASSET"   # 200, javascript
curl -s http://127.0.0.1:4747/board | head -3                  # SPA fallback → same index.html, HTTP 200
# Traversal probe (--path-as-is stops curl collapsing the dot-segments itself).
# The server normalizes the URL before serveStatic sees it (server.ts:97), so
# the path-containment guard is defense-in-depth (unit-covered) — this probe
# verifies the observable outcome: SPA index body, NEVER passwd contents.
curl --path-as-is -s "http://127.0.0.1:4747/../../../etc/passwd" | head -3   # SPA index.html, no "root:" line
```

- [x] **Step 5: API regression sweep through the same server.**

```bash
curl -s http://127.0.0.1:4747/api/profiles | node -e 'process.stdin.pipe(process.stdout)'   # zzuicheck present, hasDb true
curl -s "http://127.0.0.1:4747/api/profiles/zzuicheck/jobs" # rows[0].id == li-ui-1
curl -s "http://127.0.0.1:4747/api/profiles/zzuicheck/meta" # both vocab lists
curl -s -X PATCH -H 'content-type: application/json' -d '{"status":"Applied","notes":"via curl"}' \
  "http://127.0.0.1:4747/api/profiles/zzuicheck/jobs/li-ui-1/tracking"   # 200, tracking.status Applied
curl -s "http://127.0.0.1:4747/api/profiles/zzuicheck/jobs/li-ui-1"      # detail: tracking merged, jd present
curl -s -X PATCH -H 'content-type: application/json' -d '{"status":"Bogus"}' \
  "http://127.0.0.1:4747/api/profiles/zzuicheck/jobs/li-ui-1/tracking"   # 400 {"error":{"code":"validation",...}}
```

Any deviation → BLOCKED (report, don't improvise).

- [x] **Step 6: Teardown (in this order — the server must die before the profile is removed, or the open sqlite handle leaves WAL sidecars behind).**

```bash
kill "$(cat "${TMPDIR:-/tmp}/jb-board.pid")" && rm "${TMPDIR:-/tmp}/jb-board.pid"
sleep 1
node src/cli/main.ts profile remove --profile zzuicheck --force
git status --porcelain    # clean
```

---

## Closure (controller/advisor — NOT the lead's package)

1. Whole-branch review (opus) + one fix wave + scoped re-review.
2. kb-curator over the branch diff — **user authorization on file (2026-08-01)** for the dedicated `src/app/` §3 explainer-KB module-map entry (curator's own outline from the PR-4 report); plus: `ui/` workspace (workspace layout, type-only contract import idiom, ui gates separate from the pipeline gate), setup's local-first step semantics, CLI surface (`ui:build`/`ui:check`/`ui:dev`), CI ui job.
3. Advisor runtime verification: replicate Task 9 at final HEAD + a browser pass over the served UI (shell nav, profile switch persistence, filter → table reload, drawer open, inline status edit optimistic→server-confirm, rollback on forced 400).
4. Merge → local `main-db` only (gates: root check green + ui:check/ui:build green; Task 9 is the run test — board is app-layer, but `stage sync` participates, so the run test stands).
5. Present at merge report: harish `--apply` migration go-ahead (still pending); final CLAUDE.md wording (board/scaffold/ui) rides the eventual main-merge proposal.

## Deferred (carried forward, unchanged)

- PR-4 review minors: M5 store-opened-before-validation, M6 `close()` vs keep-alive sockets, M8 `--port` upper bound, M9 `cli/wire` at 7 impl files.
- Mirror follow-ups: malformed-slice doctor warn; persisted-subset push.
- `compose.test.ts` at 800/800; `src/ports` two-pair pressure; `stage.ts` UTC run-folder date bug (pre-existing).
- UI v2 candidates (out of scope now): component render tests, debounced company filter, keyboard nav in the table, board column for `nextActionDate` due-soon highlighting.

---

## Execution record (2026-08-01, completed)

**Branch:** `feat/ui-workspace` from `main-db` @ `15288c7`. All 9 tasks executed by the SDD lead (fresh implementer + reviewer per task); briefs/ledger/reports in `.superpowers/sdd/2026-08-02-ui-workspace/`.

**Commits:** plan `7c9d903` + `923af13` (heading fix) · T1 `e653cf1` · T2 `8336f1c` · T3 `d8b8db7` · T4 `860bfe8` · T5 `d1b3fea` · T6 `df257e9` · T7 `db103ab` · T8 `b863bba` · T6 fix round `3d93ccc` (field-level rollback via tested `commitField`) · review fix wave `fe45264` (I1 per-field save state, I2 maxlength caps, M1 connector parity, M2 `unknown` sentinel, M3 `bad_response` guard) · KB sync + `src/app/` §3 entry `c9fceb6`.

**Reviews:** design review (opus) round 1 FIX FIRST (4 Critical / 8 Important / 4 Nit — notably: archived filter is two-state never "all"; ui tsconfig needed `types:["node",…]` or the cross-boundary type chase silently degrades to `any`) → all folded into Rev 2 → APPROVED. Task reviews: all approved; T6 required the fix round (whole-row rollback could discard a concurrently confirmed edit — closed by `commitField` with a concurrency-race test). T4 blocked legitimately (scriptless stub `.svelte` files yield no module type) — resolved with empty `<script lang="ts">` blocks, no typing shims. Whole-branch review (opus): **MERGE, 0 Critical**; I1/I2/M1/M2/M3 fixed in `fe45264`; deferred/accepted: M4 raw `localStorage` (storage-disabled browsers), M5 router listener never removed (singleton), M6 BoardPage pager/sort logic untested in `.svelte`, M7 vite "no Svelte config" log, M8 client hardcodes limit 50 (4 sites) instead of reading the server echo, M9 archived-row dimming is a dead affordance (homogeneous result sets), M10 drawer doesn't special-case `no_local_db`, M11 no-op guard trims but sends untrimmed values, M12 `ui/` outside biome/filesize (intentional, noted).

**Gates at final HEAD (advisor-replicated):** root `npm run check` **1294/1294** exit 0 (baseline 1286 + 7 setup tests + 1 fix-wave test) · `npm run ui:check` svelte-check 373 files **0 errors/0 warnings** + vitest **39/39** · `npm run ui:build` clean (130 modules).

**Runtime verification (advisor, at `fe45264`):** throwaway `zzuicheck` (sqlite scaffold) seeded via UTC checkpoint + `stage sync` (1→1, exit 0, no NOTION_TOKEN). Setup smoke: `.env NOTION_TOKEN: skipped — local sqlite profile`, `ui build: done`. Board on :4747: built `index.html` served at `/`, hashed asset 200 `text/javascript`, SPA fallback `/board` 200, `--path-as-is` traversal probe returned the SPA index (0 `root:` lines). API sweep exact (profiles/list/meta/detail; PATCH valid → merged TrackingRow, invalid → 400 validation envelope). **Browser pass (Chrome):** shell + dark scheme render; profile switch rajni→zzuicheck reactively reloaded the table; drawer showed meta grid + tracking form + JD text; inline status edit Applied→Onsite propagated drawer→table optimistically and persisted server-side with only that field changed (notes untouched — field-level semantics held live); hash route `#/analytics` works; console clean. Teardown verified: profile removed, no listener/process, tree clean.

**Merged to `main-db`:** ff-merge (hash recorded in the merge commit listing below by the merge operator).
