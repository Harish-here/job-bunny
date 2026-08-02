# React + shadcn/ui Board Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Svelte board SPA with a React 19 + shadcn/ui app redesigned around triage-first flow, add sidebar branding + a `GET /api/app` version endpoint, and a Playwright critical-path e2e suite.

**Architecture:** Clean-slate rewrite of the `ui/` workspace on branch `ui-react-redesign` (spec: `docs/superpowers/specs/2026-08-02-react-shadcn-ui-redesign-design.md`). Strict data layering per feature: `*.tsx` → `use*.ts` → `*.queries.ts` → `*.api.ts` → `lib/api`. The board server API is unchanged except one new endpoint. Views: Triage (split-pane, keyboard), Tracker (kanban + due strip), full-page job detail, Analytics/Onboarding stubs.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind 4 (`@tailwindcss/vite`), shadcn/ui copy-ins, @tanstack/react-query, @dnd-kit/core, lucide-react, sonner, vitest + @testing-library/react (jsdom), @playwright/test, Biome (ui-scoped).

## Global Constraints

- Node ≥ 24; no build step for `src/` (type stripping). Never add root runtime deps (stay: `@notionhq/client`, `playwright`, `zod`).
- All new deps go in `ui/package.json` only (private workspace, outside the root gate).
- Status/excitement strings are byte-exact and come from `/api/profiles/:name/meta` (`src/core/tracking/vocab.ts`): STATUS = `Lead, Applied, Recruiter Screen, Tech Round, Onsite, Offer, Rejected, Passed`; EXCITEMENT = `Vera level, Kandipa podu, Try panalam`. Never hardcode alternatives in logic; UI may hold the decide-mapping constants below.
- Decide mapping (spec decision): Apply → `Applied`, Skip → `Passed`, Save → `Lead`. Undecided = `tracking?.status == null`. Terminal statuses for the kanban "Closed" group: `Rejected`, `Passed`.
- Board server keeps binding `127.0.0.1` and writing only the `tracking` table.
- E2E touches ONLY `profiles/rajni/` and only its local sqlite DB — never Notion, never any other profile's data.
- Branch: `ui-react-redesign`. `main` is protected — land via PR; the `test` check (`npm run check` + `ui` job) must stay green. Do not rename CI jobs.
- Commits: conventional style, no co-author trailers, no "Generated with" lines.
- localStorage key for selected profile stays `jobbunny.profile`.
- Review flags: Task 2 (server-touching), Task 11 (writes rajni DB), Task 12 (CI) require reviewer pass in sdd-task-loop.

---

### Task 1: Scaffold the React workspace (replaces Svelte wholesale)

**Files:**
- Delete: `ui/src/**` (all Svelte files + old lib), keep nothing; delete Svelte devDeps from `ui/package.json`
- Create: `ui/package.json` (rewrite), `ui/tsconfig.json`, `ui/vite.config.ts`, `ui/index.html`, `ui/biome.json`, `ui/components.json` (shadcn), `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/index.css`, `ui/src/assets/logo.svg` (copy of `assets/job-bunny-logo.svg`), `ui/src/lib/utils.ts` (shadcn cn helper), `ui/src/components/ui/*` (shadcn copy-ins)

**Interfaces:**
- Produces: a compiling, testable React app skeleton; `npm run ui:check` (root) = `tsc --noEmit` + Biome + `vitest run`; `npm run ui:build` outputs `ui/dist/index.html`. `App.tsx` renders a placeholder shell replaced in Task 5.

- [ ] **Step 1: Remove the Svelte app**

```bash
git rm -r ui/src ui/index.html ui/vite.config.ts ui/tsconfig.json
```

- [ ] **Step 2: Rewrite `ui/package.json`**

```json
{
  "name": "jobbunny-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "check": "tsc --noEmit && biome check src && vitest run",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@dnd-kit/core": "^6",
    "@tanstack/react-query": "^5",
    "lucide-react": "^0.5xx",
    "react": "^19",
    "react-dom": "^19",
    "sonner": "^2"
  },
  "devDependencies": {
    "@biomejs/biome": "same major as root",
    "@playwright/test": "^1",
    "@tailwindcss/vite": "^4",
    "@tanstack/react-query-devtools": "^5",
    "@testing-library/jest-dom": "^6",
    "@testing-library/react": "^16",
    "@testing-library/user-event": "^14",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^5",
    "jsdom": "^25",
    "tailwindcss": "^4",
    "typescript": "^5.9",
    "vite": "^8",
    "vitest": "^4"
  }
}
```

Run `npm install --prefix ui` and let npm resolve current minors; pin whatever it writes. (`lucide-react`: latest.) Update root `package.json` script `ui:check` if it doesn't already delegate to `npm --prefix ui run check` (it does — verify, don't edit blindly).

- [ ] **Step 3: `ui/vite.config.ts`** (keep the dev proxy + vitest config semantics from the old file)

```typescript
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server proxies API calls to a locally running `jobbunny board`
// (default port 1994). Production build is served BY that server from
// ui/dist, same origin — no proxy involved.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:1994' } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
});
```

Create `ui/src/test-setup.ts` containing `import '@testing-library/jest-dom/vitest';`.

- [ ] **Step 4: `ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src"]
}
```

Add `resolve: { alias: { '@': '/src' } }`-equivalent to vite config via `import path from 'node:path'` + `resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } }` (shadcn imports use `@/`).

- [ ] **Step 5: Tailwind + shadcn init**

`ui/src/index.css` starts with `@import "tailwindcss";`. Run `npx shadcn@latest init` in `ui/` (style: default, base color: neutral, CSS variables: yes) — it writes `components.json`, extends `index.css` with the theme variables, and creates `src/lib/utils.ts`. Then add the brand accent: in `index.css` override `--primary` (light: `#7B5EA7`; dark: keep readable contrast, `#B79CE0`-ish) in the `:root` / `.dark` blocks shadcn generated. Add shadcn components used later in one batch:

```bash
npx shadcn@latest add button card select input popover badge separator textarea skeleton
```

Dark mode: shadcn uses a `.dark` class. Follow system: in `main.tsx`, before render, add a `matchMedia('(prefers-color-scheme: dark)')` listener toggling `document.documentElement.classList.toggle('dark', mq.matches)` (initial + `change` event). No toggle UI.

- [ ] **Step 6: `ui/index.html`, `ui/src/main.tsx`, `ui/src/App.tsx`**

index.html: same as old but `<script type="module" src="/src/main.tsx">`, `<title>Job Bunny</title>`, and favicon `<link rel="icon" href="/src/assets/logo.svg">`. Copy the logo: `cp assets/job-bunny-logo.svg ui/src/assets/logo.svg`.

```tsx
// main.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const mq = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', mq.matches);
applyTheme();
mq.addEventListener('change', applyTheme);

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

`App.tsx` for now: `export default function App() { return <div className="p-4">Job Bunny</div>; }`

- [ ] **Step 7: `ui/biome.json`** — extend root config if root biome supports `extends`; otherwise copy the root's rule set with `"include": ["src/**"]`. Keep the same formatter settings as root (check `biome.json` at repo root and mirror).

- [ ] **Step 8: Write a smoke test `ui/src/App.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the app shell', () => {
  render(<App />);
  expect(screen.getByText(/job bunny/i)).toBeInTheDocument();
});
```

- [ ] **Step 9: Verify** — `npm run ui:check && npm run ui:build` from repo root: both green, `ui/dist/index.html` exists.

- [ ] **Step 10: Commit** — `feat(ui): react + tailwind + shadcn scaffold, svelte removed`

---

### Task 2: `GET /api/app` version endpoint  ⚑ REVIEW (server-touching)

**Files:**
- Create: `src/app/features/appinfo/routes.ts`, `src/app/features/appinfo/routes.test.ts`, `src/app/features/appinfo/index.ts`
- Modify: `src/app/server/server.ts` (accept `version` in options; register routes), `src/cli/commands/board.ts` (read root package.json version, pass through)

**Interfaces:**
- Produces: `GET /api/app` → `200 {"version":"<root package.json version>"}`. `BoardServerOptions` gains `version: string`. `makeAppInfoRoutes(version: string): RouteDef[]` exported from `src/app/features/appinfo/index.ts`.
- Constraint: `app/` imports only `ports`/`core` — the version is READ in `cli/commands/board.ts` (I/O stays in cli) and passed in as a string.

- [ ] **Step 1: Failing test** `src/app/features/appinfo/routes.test.ts` — follow the existing route-test pattern in `src/app/features/board/routes.test.ts` (same harness/helpers):

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeAppInfoRoutes } from './routes.ts';

test('GET /api/app returns the injected version', async () => {
  const [route] = makeAppInfoRoutes('9.9.9');
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/app');
  // invoke handler with the same fake request/response the board route tests use
  // assert JSON body deep-equals { version: '9.9.9' }
});
```

Mirror the exact request/response fakes used in `board/routes.test.ts` — do not invent a new harness.

- [ ] **Step 2: Run** `node --test src/app/features/appinfo/routes.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement** `routes.ts` following `makeBoardRoutes`' `RouteDef` shape:

```typescript
import type { RouteDef } from '../../server/index.ts'; // use the actual RouteDef import path found in board/routes.ts

export function makeAppInfoRoutes(version: string): RouteDef[] {
  return [
    { method: 'GET', path: '/api/app', handler: () => ({ status: 200, body: { version } }) },
  ];
}
```

(Match the real handler signature — copy the shape from the simplest existing handler, `metaHandler`.) `index.ts` re-exports `makeAppInfoRoutes`.

- [ ] **Step 4: Wire** — `server.ts`: add `version: string` to `BoardServerOptions`; `const routes = [...makeProfilesRoutes(source), ...makeBoardRoutes(source), ...makeAppInfoRoutes(version)]`. `cli/commands/board.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
) as { version: string };
// pass version: pkg.version into resolved.createServer({ source, logger, uiDir, version: pkg.version })
```

Update any other `createBoardServer` call sites (tests) the compiler flags.

- [ ] **Step 5: Verify** — `node --test src/app/features/appinfo/routes.test.ts` PASS, then full gate `npm run check` (boundaries included — `app/` must not import `node:fs`).

- [ ] **Step 6: Commit** — `feat(board): GET /api/app exposes running server version`

---

### Task 3: lib ports — router hook, api client, types, profile persistence

**Files:**
- Create: `ui/src/lib/router.ts` + `router.test.ts`, `ui/src/lib/api/client.ts` + `client.test.ts`, `ui/src/lib/api/types.ts`, `ui/src/lib/profile.ts` + `profile.test.ts`

**Interfaces:**
- Produces:
  - `type Route = { name: 'triage' | 'tracker' | 'analytics' | 'onboarding' } | { name: 'job'; id: string }`
  - `parseHash(hash: string): Route`; `useRoute(): Route`; `navigate(to: Route): void` (module fn, sets `location.hash`)
  - `ApiError`, `buildQuery`, `getJson<T>`, `patchJson<T>` — identical semantics to the Svelte versions
  - `pickProfile(stored: string | null, profiles: BoardProfile[]): string | null` (pure); `useProfile(profiles?: BoardProfile[]): { current: string | null; choose(name: string): void }` — localStorage key `jobbunny.profile`
  - `types.ts` re-exports backend contract types (type-only) from `../../../../src/app/features/board/index.ts` and `.../profiles/index.ts` — copy the old file verbatim, it is framework-free.

- [ ] **Step 1: Failing tests for the router** `router.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { parseHash, routeHash } from './router';

describe('parseHash', () => {
  test.each([
    ['', 'triage'], ['#/', 'triage'], ['#/nope', 'triage'],
    ['#/triage', 'triage'], ['#/tracker', 'tracker'],
    ['#/analytics', 'analytics'], ['#/onboarding', 'onboarding'],
  ])('%s → %s', (hash, name) => {
    expect(parseHash(hash)).toEqual({ name });
  });
  test('job route with id', () => {
    expect(parseHash('#/job/abc%20d')).toEqual({ name: 'job', id: 'abc d' });
  });
  test('job route without id falls back to triage', () => {
    expect(parseHash('#/job')).toEqual({ name: 'triage' });
  });
});
test('routeHash round-trips', () => {
  expect(routeHash({ name: 'job', id: 'x/y' })).toBe('#/job/x%2Fy');
});
```

- [ ] **Step 2: Run → FAIL** (`npm --prefix ui run test`)

- [ ] **Step 3: Implement `router.ts`**

```typescript
import { useSyncExternalStore } from 'react';

export const ROUTES = ['triage', 'tracker', 'analytics', 'onboarding'] as const;
export type RouteName = (typeof ROUTES)[number];
export type Route = { name: RouteName } | { name: 'job'; id: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'job' && parts[1]) return { name: 'job', id: decodeURIComponent(parts[1]) };
  const name = parts[0] ?? '';
  return (ROUTES as readonly string[]).includes(name)
    ? { name: name as RouteName }
    : { name: 'triage' };
}

export function routeHash(route: Route): string {
  return route.name === 'job' ? `#/job/${encodeURIComponent(route.id)}` : `#/${route.name}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}
```

- [ ] **Step 4: Port `client.ts` + `types.ts` verbatim from git history** (`git show origin/main:ui/src/lib/api/client.ts`) — they contain no Svelte. Port `client.test.ts` from history, converting `node:test`/svelte-isms to vitest if any (it should be plain).

- [ ] **Step 5: `profile.ts`** — failing tests first (port cases from history: stored-name-wins-if-present, falls back to first `hasDb`, then first, then null; choose persists):

```typescript
import type { BoardProfile } from './api/types';

const STORAGE_KEY = 'jobbunny.profile';

export function pickProfile(stored: string | null, profiles: BoardProfile[]): string | null {
  const names = profiles.map((p) => p.name);
  if (stored !== null && names.includes(stored)) return stored;
  return profiles.find((p) => p.hasDb)?.name ?? names[0] ?? null;
}

import { useCallback, useSyncExternalStore } from 'react';

let listeners: (() => void)[] = [];
function emit() { for (const l of listeners) l(); }

export function useStoredProfile(): [string | null, (name: string) => void] {
  const stored = useSyncExternalStore(
    (cb) => { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; },
    () => localStorage.getItem(STORAGE_KEY),
  );
  const choose = useCallback((name: string) => { localStorage.setItem(STORAGE_KEY, name); emit(); }, []);
  return [stored, choose];
}
```

Test `pickProfile` as a pure function (all four fallback cases); test `useStoredProfile` with `renderHook` + `act`.

- [ ] **Step 6: Run all ui tests → PASS; Step 7: Commit** — `feat(ui): port router/api/profile libs to react hooks`

---

### Task 4: Data layer — query keys, board/profiles/appinfo api+queries+hooks, tracking mutation

**Files:**
- Create: `ui/src/features/board/board.api.ts`, `board.queries.ts`, `useBoardData.ts`, `tracking.ts` + `tracking.test.ts`, `useTracking.ts` + `useTracking.test.tsx`
- Create: `ui/src/features/shell/profiles.api.ts`, `profiles.queries.ts`, `useProfiles.ts`, `appinfo.api.ts`, `appinfo.queries.ts`, `useAppInfo.ts`

**Interfaces:**
- Consumes: Task 3 (`getJson`, `patchJson`, `buildQuery`, types).
- Produces (used by every view task):
  - `boardKeys = { meta:(p)=>[p,'meta'], jobs:(p,q)=>[p,'jobs',q], job:(p,id)=>[p,'job',id] }`
  - `useJobs(profile: string, query: ListQuery)` → `useQuery` of `BoardListResponse`
  - `useJob(profile: string, id: string)` → `useQuery` of `BoardDetailResponse`
  - `useMeta(profile: string)` → `BoardMetaResponse`
  - `useProfilesQuery()` → `ProfilesResponse`; `useAppInfo()` → `{ version: string }`
  - `applyPatch(existing: TrackingRow | null, jobId: string, patch: TrackingPatchBody): TrackingRow` (verbatim port)
  - `useTrackingMutation(profile: string)` → `mutate({ jobId, patch })` with optimistic field-level update + rollback; invalidates `[profile,'jobs']` prefix on settle.

- [ ] **Step 1: `board.api.ts`** — port the Svelte `features/board/api.ts` verbatim (adjust import path to `../../lib/api/client`). Same four functions: `listJobs`, `getJob`, `patchTracking`, `getMeta`.

- [ ] **Step 2: `board.queries.ts`**

```typescript
import { queryOptions } from '@tanstack/react-query';
import type { ListQuery } from '../../lib/api/types';
import { getJob, getMeta, listJobs } from './board.api';

export const boardKeys = {
  profile: (p: string) => [p] as const,
  meta: (p: string) => [p, 'meta'] as const,
  jobs: (p: string, q: ListQuery) => [p, 'jobs', q] as const,
  jobsPrefix: (p: string) => [p, 'jobs'] as const,
  job: (p: string, id: string) => [p, 'job', id] as const,
};

export const metaQuery = (p: string) =>
  queryOptions({ queryKey: boardKeys.meta(p), queryFn: () => getMeta(p), staleTime: Infinity });
export const jobsQuery = (p: string, q: ListQuery) =>
  queryOptions({ queryKey: boardKeys.jobs(p, q), queryFn: () => listJobs(p, q) });
export const jobQuery = (p: string, id: string) =>
  queryOptions({ queryKey: boardKeys.job(p, id), queryFn: () => getJob(p, id) });
```

- [ ] **Step 3: `useBoardData.ts`** — thin hooks: `useJobs(p,q)`/`useJob(p,id)`/`useMeta(p)` wrapping `useQuery(xQuery(...))`. Components import ONLY these (layering rule).

- [ ] **Step 4: `tracking.ts`** — port `applyPatch` verbatim from git history (`git show origin/main:ui/src/features/board/tracking.ts` — take `applyPatch` only; `commitField`'s semantics move into the mutation next step). Port the `applyPatch` test cases verbatim to vitest.

- [ ] **Step 5: Failing tests for `useTracking.ts`** (`useTracking.test.tsx`, renderHook with a real `QueryClient` and `vi.stubGlobal('fetch', …)`):

Cases (mirror old `commitField` tests):
1. optimistic: cache for `job(p,id)` shows patched status before fetch resolves
2. success: server row replaces optimistic row; `jobsPrefix` invalidated
3. failure: only the patched field rolls back (seed cache, patch `{status}`, concurrently-updated `notes` in cache survives), toast fired (assert via sonner mock `vi.mock('sonner')`)
4. no-op guard: `commitField(jobId, field, raw)` returns early when raw equals current value (empty-string vs absent both count as unchanged)

- [ ] **Step 6: Implement `useTracking.ts`**

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BoardDetailResponse, TrackingPatchBody, TrackingRow } from '../../lib/api/types';
import { patchTracking } from './board.api';
import { boardKeys } from './board.queries';
import { applyPatch } from './tracking';

interface Vars { jobId: string; patch: TrackingPatchBody }

export function useTrackingMutation(profile: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, patch }: Vars) => patchTracking(profile, jobId, patch),
    onMutate: async ({ jobId, patch }) => {
      await qc.cancelQueries({ queryKey: boardKeys.job(profile, jobId) });
      const detail = qc.getQueryData<BoardDetailResponse>(boardKeys.job(profile, jobId));
      const previous: TrackingPatchBody = {};
      for (const key of Object.keys(patch) as (keyof TrackingPatchBody)[]) {
        previous[key] = (detail?.tracking?.[key] ?? null) as never;
      }
      const write = (row: TrackingRow) => {
        qc.setQueryData<BoardDetailResponse>(boardKeys.job(profile, jobId), (d) =>
          d ? { ...d, tracking: row } : d);
        qc.setQueriesData({ queryKey: boardKeys.jobsPrefix(profile) }, (list: unknown) => {
          const l = list as { rows: { id: string; tracking: TrackingRow | null }[] } | undefined;
          return l ? { ...l, rows: l.rows.map((r) => (r.id === jobId ? { ...r, tracking: row } : r)) } : l;
        });
      };
      write(applyPatch(detail?.tracking ?? null, jobId, patch));
      return { previous, write };
    },
    onError: (err, { jobId }, ctx) => {
      if (ctx) {
        const detail = qc.getQueryData<BoardDetailResponse>(boardKeys.job(profile, jobId));
        ctx.write(applyPatch(detail?.tracking ?? null, jobId, ctx.previous));
      }
      toast.error(`Save failed — rolled back: ${err instanceof Error ? err.message : String(err)}`);
    },
    onSuccess: (res, { jobId }, ctx) => ctx?.write(res.tracking),
    onSettled: () => qc.invalidateQueries({ queryKey: boardKeys.jobsPrefix(profile) }),
  });
}

/** Field-level edit helper for form inputs: no-op guard + empty→null. */
export function fieldPatch(
  current: TrackingRow | null,
  field: keyof TrackingPatchBody,
  raw: string,
): TrackingPatchBody | null {
  const previous = current?.[field];
  if (raw === (previous ?? '') || (raw.trim() === '' && (previous ?? '') === '')) return null;
  return { [field]: raw.trim() === '' ? null : raw } as TrackingPatchBody;
}
```

- [ ] **Step 7: shell data files** — `profiles.api.ts` (`getProfiles(): Promise<ProfilesResponse>` via `getJson('/api/profiles')`), `appinfo.api.ts` (`getApp(): Promise<{version:string}>` via `getJson('/api/app')`), each with a `*.queries.ts` (`['profiles']` / `['app']`, `staleTime: Infinity`) and `use*.ts` hook.

- [ ] **Step 8: Run ui tests → PASS. Step 9: Commit** — `feat(ui): tanstack data layer with field-level optimistic tracking`

---

### Task 5: Shell — sidebar branding, nav, profile switcher, error states

**Files:**
- Create: `ui/src/features/shell/Sidebar.tsx`, `ProfileSwitcher.tsx`, `Shell.tsx` + `Shell.test.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `useRoute`/`navigate` (T3), `useProfilesQuery`, `useAppInfo`, `pickProfile`, `useStoredProfile` (T3/T4).
- Produces: `<Shell>` renders sidebar + routed page; exposes `profile: string` to pages via prop. Page components (Tasks 6–10) plug in via a switch on `route.name`.

- [ ] **Step 1: Failing test `Shell.test.tsx`** — with fetch stubbed (`/api/profiles` → rajni+harish, `/api/app` → `{version:'2.1.0'}`): renders logo img with alt "Job Bunny", the title text, "v2.1.0", all four nav items; profile defaults per `pickProfile`; server-unreachable case (fetch rejects) renders retry state; clicking retry refetches.

- [ ] **Step 2: Implement.** Sidebar structure (Tailwind, shadcn `Select` for the switcher):

```tsx
// Sidebar.tsx (props: route: Route, profile: string | null, profiles: BoardProfile[],
//              version: string | undefined, onChoose(name), onNavigate(route))
<aside className="flex h-screen w-56 flex-col gap-4 border-r p-4">
  <div className="flex items-center gap-2">
    <img src={logo} alt="Job Bunny" className="size-7" />
    <div>
      <div className="font-bold leading-tight">Job Bunny</div>
      {version && <div className="text-xs text-muted-foreground">v{version}</div>}
    </div>
  </div>
  <nav className="flex flex-col gap-1">{/* Triage/Tracker/Analytics/Onboarding buttons,
    active = route.name match, Button variant="ghost" + active styling */}</nav>
  <div className="mt-auto">{/* ProfileSwitcher: shadcn Select; option label
    `${name}${hasDb ? '' : ' (no local db)'}` */}</div>
</aside>
```

`import logo from '../../assets/logo.svg';` — vite returns the URL. `Shell.tsx` composes: profiles query states (loading skeleton / error + Retry button calling `refetch` / ready), computes `profile = pickProfile(stored, profiles)`, renders page switch. `App.tsx` = `<Shell/>` + `<Toaster/>` (sonner).

- [ ] **Step 3: Tests PASS. Step 4: Commit** — `feat(ui): shell with branded sidebar, version, profile switcher`

---

### Task 6: Triage view — list + detail pane (read path)

**Files:**
- Create: `ui/src/features/job/JobHeader.tsx`, `JobFacts.tsx`, `JdText.tsx` (shared detail components)
- Create: `ui/src/features/triage/TriagePage.tsx`, `JobList.tsx`, `JobRow.tsx`, `FilterPopover.tsx`, `selection.ts` + `selection.test.ts`

**Interfaces:**
- Consumes: `useJobs`, `useJob`, `useMeta` (T4).
- Produces: `TriagePage({ profile })`; `selection.ts` exports `useTriageSelection(rows: BoardJobRow[]): { selectedId: string | null; select(id: string): void; move(delta: 1 | -1): void }` and module-level `rememberSelection(id)/recallSelection()` (plain vars) used by Task 9's back-navigation.
- Query defaults (port of old BoardPage): `{ sort: 'date_found', order: 'desc', archived: 'false', limit: 50, offset: 0 }`; filter change resets offset to 0.

- [ ] **Step 1: Failing tests for `selection.ts`** — pure logic: defaults to first row when null/stale; `move(+1/-1)` clamps at ends; selection survives row refetch when id still present.
- [ ] **Step 2: Implement selection hook** (useState + useEffect reconciling against `rows`; module-level `let lastSelection: string | null` with exported `rememberSelection`/`recallSelection`; initialize state from `recallSelection()` when the id is in `rows`).
- [ ] **Step 3: Build the view.** Layout:

```tsx
// TriagePage
<div className="grid h-screen grid-cols-[minmax(280px,360px)_1fr]">
  <section className="overflow-y-auto border-r">
    {/* header: undecided count (rows where tracking?.status == null), sort toggle
        (date_found/score + asc/desc), FilterPopover */}
    <JobList rows={rows} selectedId={selectedId} onSelect={select} />
  </section>
  <section className="overflow-y-auto p-6">
    {/* JobHeader (title, company link→url, score Badge, dateFound, archived dim),
        JobFacts (locationCity — workType, timezone, seniority, skills badges,
        matchReasons list, reviewFlags list, excitement),
        JdText (jd.content raw text if present, else muted "no JD captured"),
        DecideBar placeholder (Task 7), TrackingPanel placeholder (Task 8) */}
  </section>
</div>
```

`JobRow`: title, company, score `Badge`, `locationCity`/`workType` line, status dot (colored by `tracking?.status`, gray when undecided); dense (`py-1.5`), `aria-selected`, click → `select(id)`. FilterPopover (shadcn `Popover`): status `Select` (from meta), excitement `Select`, company `Input` (max 200), dateFrom/dateTo date inputs, archived toggle — emits `Partial<ListQuery>` patches exactly like the old FilterBar (empty → undefined). Pagination: Prev/Next buttons over `total/limit/offset`.
Empty/edge states: `no_local_db` → friendly empty state; empty rows → "no jobs match"; loading → `Skeleton` rows.

- [ ] **Step 4: RTL smoke test** (`TriagePage.test.tsx`, stubbed fetch): rows render, click selects, detail pane shows selected job's title, `no_local_db` state renders.
- [ ] **Step 5: ui:check green. Step 6: Commit** — `feat(ui): triage split-pane read path`

---

### Task 7: Triage decide bar + keyboard flow

**Files:**
- Create: `ui/src/features/triage/decide.ts` + `decide.test.ts`, `DecideBar.tsx`, `useTriageKeyboard.ts` + `useTriageKeyboard.test.tsx`
- Modify: `ui/src/features/triage/TriagePage.tsx`

**Interfaces:**
- Consumes: `useTrackingMutation` (T4), `useTriageSelection` (T6).
- Produces: `DECIDE_STATUS = { apply: 'Applied', skip: 'Passed', save: 'Lead' } as const`; `nextUndecided(rows, fromId): string | null`; `DecideBar({ job, onDecide })`; keyboard: `j/k`/arrows move, `a/x/s` decide+advance, `Enter` → `navigate({name:'job', id})`, `/` focuses the filter search input (`data-search-input` attribute).

- [ ] **Step 1: Failing tests `decide.test.ts`**: `nextUndecided` returns the next row AFTER the current one with `tracking?.status == null`, wrapping to earlier rows, `null` when none; DECIDE_STATUS values byte-match vocab strings.
- [ ] **Step 2: Implement `decide.ts`** (pure). 
- [ ] **Step 3: Failing hook test** — `useTriageKeyboard` renderHook with a synthetic keydown dispatch: `j` calls `move(+1)`; `a` calls `onDecide('apply')`; keys are IGNORED when `event.target` is `input|textarea|select|[contenteditable]`.
- [ ] **Step 4: Implement `useTriageKeyboard.ts`** — `useEffect` window keydown listener with the guard:

```typescript
const t = e.target as HTMLElement;
if (t.closest('input,textarea,select,[contenteditable="true"]')) return;
```

- [ ] **Step 5: Wire into TriagePage** — decide = `mutation.mutate({ jobId, patch: { status: DECIDE_STATUS[action] } })` then `select(nextUndecided(rows, jobId) ?? jobId)`. DecideBar: three `Button`s with kbd hints (`✓ Apply (a)`, `✗ Skip (x)`, `☆ Save (s)`); current status shown as `Badge` when decided.
- [ ] **Step 6: Tests + ui:check PASS. Step 7: Commit** — `feat(ui): keyboard triage with decide-and-advance`

---

### Task 8: Tracking panel (shared form)

**Files:**
- Create: `ui/src/features/job/TrackingPanel.tsx` + `TrackingPanel.test.tsx`
- Modify: `ui/src/features/triage/TriagePage.tsx` (mount it under the detail pane, collapsible)

**Interfaces:**
- Consumes: `useTrackingMutation` + `fieldPatch` (T4), `useMeta` (T4).
- Produces: `TrackingPanel({ profile, job })` — fields: status (Select from meta.statusOptions + "—" clear option), dateApplied (date), compRange (Input max 500), contact (Input max 500), nextAction (Input max 500), nextActionDate (date), notes (Textarea max 5000, 3 rows). Commit on blur (inputs) / change (selects, dates): `const p = fieldPatch(job.tracking, field, raw); if (p) mutation.mutate({ jobId: job.id, patch: p })`. Collapsible via shadcn pattern (`details`-style with Separator; no extra component needed). "Saving…" indicator while `mutation.isPending`.

- [ ] **Step 1: Failing tests**: renders current values; blur with unchanged value fires NO fetch (no-op guard); clearing a field PATCHes `{field: null}`; select change PATCHes status; pending state shows "Saving…".
- [ ] **Step 2: Implement; tests PASS. Step 3: Commit** — `feat(ui): tracking panel with per-field optimistic commits`

---### Task 9: Tracker view — kanban + due strip

**Files:**
- Create: `ui/src/features/tracker/TrackerPage.tsx`, `grouping.ts` + `grouping.test.ts`, `DueStrip.tsx`, `KanbanColumn.tsx`, `KanbanCard.tsx`

**Interfaces:**
- Consumes: `useJobs`, `useMeta`, `useTrackingMutation` (T4); `navigate` (T3).
- Produces: `TrackerPage({ profile })`. `grouping.ts` exports:
  - `TERMINAL_STATUSES = ['Rejected', 'Passed'] as const`
  - `groupByStatus(rows: BoardJobRow[], statusOptions: string[]): { columns: { status: string; rows: BoardJobRow[] }[]; closed: BoardJobRow[] }` — column order = vocab order minus terminals; rows with `tracking?.status == null` are EXCLUDED (triage's domain); terminals pool into `closed`.
  - `dueRows(rows: BoardJobRow[], today: string): BoardJobRow[]` — `tracking?.nextActionDate <= today` (ISO date string compare), sorted ascending by date.
- Data: single `useJobs(profile, { archived: 'false', limit: 200, offset: 0, sort: 'date_found', order: 'desc' })` and client-side grouping. KNOWN LIMIT: >200 active jobs truncates — acceptable at current volumes, noted in code comment.

- [ ] **Step 1: Failing tests `grouping.test.ts`**: column order matches vocab order; undecided excluded; terminals pooled; empty statusOptions → no columns; `dueRows` includes today + overdue only, sorted, ignores rows without `nextActionDate`.
- [ ] **Step 2: Implement grouping (pure). Step 3: Build the view:**

```tsx
// TrackerPage: DueStrip on top (hidden when empty), then
<div className="flex gap-3 overflow-x-auto p-4">
  {columns.map((col) => <KanbanColumn key={col.status} ... />)}
  <ClosedColumn /* collapsed by default: header "Closed (n)" + expand toggle */ />
</div>
```

dnd-kit: `DndContext` with `onDragEnd`; each card `useDraggable({ id: job.id })`, each column `useDroppable({ id: status })`; drop → `mutation.mutate({ jobId, patch: { status } })` (skip when unchanged). Click-change fallback: a small status `Select` on each card. Card: company, title, `dateApplied ?? dateFound`, `nextAction` + `nextActionDate` (red when overdue); click (not drag) → `navigate({ name: 'job', id })`. DueStrip: horizontal `Badge` list "⚡ {company} — {nextAction} ({date})", click → `navigate` to the job.
- [ ] **Step 4: RTL smoke (columns render from stubbed meta+jobs; due strip shows overdue). Step 5: ui:check. Step 6: Commit** — `feat(ui): tracker kanban with due strip`

---

### Task 10: Full-page job detail + analytics/onboarding stubs + final assembly

**Files:**
- Create: `ui/src/features/job/JobPage.tsx` + `JobPage.test.tsx`, `ui/src/features/analytics/AnalyticsPage.tsx`, `ui/src/features/onboarding/OnboardingPage.tsx`
- Modify: `ui/src/features/shell/Shell.tsx` (full route switch)

**Interfaces:**
- Consumes: `useJob` (T4), shared job components + `TrackingPanel` (T6/T8), `rememberSelection` (T6).
- Produces: `JobPage({ profile, id })` — two-column (`grid-cols-[1fr_360px]`): left JD prose (`JobHeader` + `JdText`), right `JobFacts` + `TrackingPanel`. Back button: `rememberSelection(id); history.length > 1 ? history.back() : navigate({ name: 'triage' })`. Stubs keep the existing copy verbatim: analytics "Coming soon — run stats, funnel drops, and match-quality trends will land here."; onboarding "Coming soon — guided profile onboarding in the browser. For now, run the /setup wizard in Claude Code."

- [ ] **Step 1: Failing test**: JobPage renders title + tracking panel from stubbed fetch; back with empty history navigates to `#/triage`; not-found (404) renders "job not found" state.
- [ ] **Step 2: Implement pages; wire Shell's switch: `triage|tracker|analytics|onboarding|job`.**
- [ ] **Step 3: Full `npm run ui:check && npm run ui:build` green. Step 4: Manual smoke (optional but recommended): `node src/cli/main.ts board` + open http://127.0.0.1:1994.**
- [ ] **Step 5: Commit** — `feat(ui): full-page job detail, stub pages, route assembly`

---

### Task 11: E2E — rajni seeding + critical-path smoke suite  ⚑ REVIEW (writes rajni DB; must never touch Notion or other profiles)

**Files:**
- Create: `ui/playwright.config.ts`, `ui/e2e/fixtures.ts`, `ui/e2e/seed.ts`, `ui/e2e/smoke.spec.ts`
- Modify: `ui/package.json` (script `e2e` exists from T1), root `package.json` (add `"ui:e2e": "npm --prefix ui run e2e"`)

**Interfaces:**
- Consumes: the running board server + built `ui/dist`; sqlite adapter exports `openJobsDb`, `SqliteStore` from `src/adapters/db/sqlite/store/index.ts`; `JDSchema` from `src/core/jd/index.ts` (verify the exact export name in that index before writing fixtures).
- Produces: `npm run ui:e2e` (root) — seeds `profiles/rajni/data/jobbunny.db`, boots `jobbunny board --port 4199`, runs ~8 specs headless chromium.

- [ ] **Step 1: `ui/e2e/fixtures.ts`** — a `makeJd(overrides)` builder returning objects validated against the real schema:

```typescript
import { JDSchema } from '../../src/core/jd/index.ts'; // confirm export name via that index.ts

export function makeJd(over: { id: string; title: string; company: string; status?: never } & Record<string, unknown>) {
  const jd = {
    /* minimal JDSchema-valid object: identity {id/url/title/company/lane/dateFound…},
       content { text: '…JD body…' }, structured { locationCity, workType, skills… },
       evaluation { score, matchReasons, reviewFlags, excitement } — fill required
       fields by READING src/core/jd/schema.ts, then: */
    ...over,
  };
  return JDSchema.parse(jd); // throws at seed time if fixture drifts from schema
}
export const FIXTURE_JOBS = [ /* 10 jobs: ids rajni-e2e-1…10, varied scores 95…50,
  companies AlphaCo…, 3 with tracking added at seed time via importTracking:
  one 'Applied', one 'Tech Round' with nextActionDate = yesterday (due strip),
  one 'Rejected' (closed column) */ ];
```

The schema-parse guard is the correctness mechanism: the implementer shapes fixtures until `JDSchema.parse` passes — no silent drift.

- [ ] **Step 2: `ui/e2e/seed.ts`** (run via `node` as playwright `globalSetup`):

```typescript
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore, openJobsDb } from '../../src/adapters/db/sqlite/store/index.ts';
import { FIXTURE_JOBS } from './fixtures.ts';

export default function seed() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dbPath = path.join(root, 'profiles', 'rajni', 'data', 'jobbunny.db');
  if (!dbPath.includes(`${path.sep}rajni${path.sep}`)) throw new Error('refusing: not rajni');
  rmSync(dbPath, { force: true });
  const db = openJobsDb(dbPath);
  const store = new SqliteStore(db);
  const now = '2026-08-02T00:00:00.000Z';
  store.upsertJobs(FIXTURE_JOBS, now);
  store.importTracking([
    { jobId: 'rajni-e2e-2', fields: { status: 'Applied' }, updatedAt: now },
    { jobId: 'rajni-e2e-3', fields: { status: 'Tech Round', nextAction: 'prep sys design', nextActionDate: '2026-08-01' }, updatedAt: now },
    { jobId: 'rajni-e2e-4', fields: { status: 'Rejected' }, updatedAt: now },
  ]);
  db.close();
}
```

Also delete WAL siblings (`jobbunny.db-wal`, `jobbunny.db-shm`) in the `rmSync` step.

- [ ] **Step 3: `ui/playwright.config.ts`**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/seed.ts',
  use: { baseURL: 'http://127.0.0.1:4199' },
  webServer: {
    command: 'node src/cli/main.ts board --port 4199',
    cwd: '..',
    url: 'http://127.0.0.1:4199/api/profiles',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
```

Every test starts with `await page.addInitScript(() => localStorage.setItem('jobbunny.profile', 'rajni'));` — never rely on default profile pick (the dev machine has real profiles).

- [ ] **Step 4: `ui/e2e/smoke.spec.ts`** — 8 specs:

1. **board loads**: goto `/#/triage` → job rows visible, count ≥ 9 (10 minus none-archived), highest-score row selected content in detail pane
2. **sidebar branding**: logo img alt "Job Bunny", text "Job Bunny", version matches `/^v\d+\.\d+\.\d+$/` (assert equals `v` + root package.json version read in the test via fs)
3. **filter narrows**: open filter popover, set company to a fixture company → row count drops to that company's rows; clear → restored
4. **keyboard selection**: press `j` → `aria-selected` moves to second row; `k` → back
5. **decide persists**: select an undecided fixture job, press `a` → status badge "Applied" appears; `page.reload()` → same job still "Applied" (DB write proven)
6. **tracker kanban**: goto `/#/tracker` → columns "Lead"…"Offer" visible, `rajni-e2e-3`'s card in "Tech Round", closed column collapsed with count ≥ 1, due strip shows the overdue next action
7. **kanban move**: on `rajni-e2e-2`'s card use the status Select → "Onsite" → card re-renders in Onsite column; reload → still there
8. **full-page detail + back**: from triage press Enter → URL `#/job/<id>`, JD text visible; click Back → `#/triage` and the same row is selected

Write real playwright assertions (`expect(page.getByRole(...)).toBeVisible()` etc.) with stable selectors — add `data-testid` attributes in components where roles are ambiguous (job rows: `data-testid="job-row"`).

- [ ] **Step 5: Run locally**: `npm run ui:build && npx playwright install chromium && npm run ui:e2e` → all pass; verify `git status` shows NO changes under `profiles/rajni/` (db files are gitignored — confirm, and confirm `cache.json`/`jobs_raw.json` untouched).
- [ ] **Step 6: Commit** — `test(ui): playwright critical-path smoke suite with rajni seeding`

---

### Task 12: CI wiring  ⚑ REVIEW (CI)

**Files:**
- Modify: `.github/workflows/test.yml` (ui job only)

**Interfaces:**
- Consumes: Task 11's `ui:e2e` root script.
- Produces: the `ui` job additionally runs the e2e suite. Job names `check`/`ui`/`test` unchanged (branch protection pins `test`).

- [ ] **Step 1: Edit the `ui` job** — after the `npm run ui:build` step, add:

```yaml
      - run: npm --prefix ui exec playwright install --with-deps chromium
      - run: npm run ui:e2e
```

Note: root `npm ci` runs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — that's why the explicit install step exists. `--prefix ui` matters: `@playwright/test` lives in the ui workspace.
- [ ] **Step 2: Verify locally** with `act` if available; otherwise validate YAML (`node -e "require('js-yaml')..."` or push and watch). Do NOT restructure the workflow.
- [ ] **Step 3: Commit** — `ci: run board e2e smoke suite in the ui job`
- [ ] **Step 4: Push branch + open PR** (title `feat(ui): react + shadcn board redesign`) — wait for the `test` check. Landing the PR is a separate user decision.

---

## Self-review notes (resolved inline)

- Spec coverage: shell/branding (T5), /api/app (T2), triage (T6+T7), tracking form (T8), kanban+due (T9), job page + stubs (T10), e2e (T11), CI (T12), layering (T3/T4), Svelte deletion (T1). Housekeeping `.gitignore` `.superpowers/` — already committed with the spec.
- Types used across tasks cross-checked: `boardKeys`, `useTrackingMutation`, `fieldPatch`, `DECIDE_STATUS`, `nextUndecided`, `groupByStatus`, `dueRows`, `rememberSelection` are each defined exactly once and consumed by name.
- Known deliberate gaps: kanban 200-row cap (commented); analytics/onboarding remain stubs (spec non-goal); CLAUDE.md "biome scopes to src/**" wording needs a kb-curator touch-up at wrap time.
