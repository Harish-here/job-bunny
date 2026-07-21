# v2 P1 — Skeleton + Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the v2 toolchain and the compile-time contracts every later phase imports: `src/` tree, `core/errors`, `core/jd` (universal JD schema + normalizer), `core/config`, `core/profile`, all seven `ports/*` interfaces, boundary enforcement, and CI.

**Architecture:** Hexagonal-lite per `docs/superpowers/specs/2026-07-21-main-v2-architecture-design.md` (§3–§4) and the decision log `main-v2.md`. This phase writes **no adapters, no pipeline, no CLI** — only pure core modules, type-only ports, and tooling. v0 under `scripts/` is untouched and must keep passing.

**Tech Stack:** Node ≥ 24 (native TS type-stripping, zero build), TypeScript 7 `--noEmit`, zod v4, `node:test`, Biome, dependency-cruiser.

## Global Constraints

- Branch: work on `feat/v2-p1-skeleton` off `main-v2`; PR back into `main-v2`.
- Runtime deps: exactly `playwright`, `@notionhq/client`, `zod` (+ `dotenv` until P9 removes v0). Never add others.
- TS: strict, ESM, **erasable-syntax-only** — no enums, no namespaces, no parameter properties. Plain types + unions.
- Relative imports always carry the `.ts` extension (Node type-stripping requires it).
- Every module folder gets an `index.ts` public surface; internals are never imported across module boundaries.
- **Two-pair rule:** a folder with more than two implementation files (main + test pairs, `index.ts` excluded) splits into subfolders.
- Colocated tests: `foo.ts` + `foo.test.ts`, `node:test` + `node:assert/strict`.
- Tests never launch a browser; every `npm i`/`npm ci` runs with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- Comment headers state the contract (what the module is, its invariants), not implementation narration.
- v0 (`scripts/`, `.claude/commands/`, CLAUDE.md body) is not modified except the single CLAUDE.md pointer section in Task 8.

## File Structure

```
tsconfig.json                     Task 1   TS7 strict/erasable/noEmit config
biome.json                        Task 1   lint + format, src/ only
.dependency-cruiser.cjs           Task 7   one-way dependency rules
.github/workflows/test.yml        Task 8   Node 24; typecheck+lint+boundaries+test
package.json                      Task 1   engines, scripts, dev deps, zod
src/core/errors/soft_error.ts     Task 1   SoftError + isSoftError
src/core/errors/index.ts          Task 1
src/core/jd/schema.ts             Task 2   universal JD zod schema + staged types
src/core/jd/normalize.ts          Task 3   normalizeToken, companyKey
src/core/jd/index.ts              Task 3
src/core/config/schema.ts         Task 4   PipelineConfig (what's enabled)
src/core/config/index.ts          Task 4
src/core/profile/schema.ts        Task 5   Resume, SkillClassification
src/core/profile/index.ts         Task 5
src/ports/context.ts              Task 6   Logger, RunContext (minimal)
src/ports/connector.ts            Task 6
src/ports/lane.ts                 Task 6
src/ports/notifier.ts             Task 6
src/ports/llm.ts                  Task 6
src/ports/browser.ts              Task 6
src/ports/scheduler.ts            Task 6
src/ports/storage.ts              Task 6
src/ports/index.ts                Task 6
src/ports/contracts.test.ts       Task 6   fake impls prove interfaces implementable
main-v2.md                        Task 8   phase-status update
CLAUDE.md                         Task 8   one pointer section for the v2 tree
```

`adapters/`, `pipeline/`, `routines/`, `ops/`, `cli/` are **not** created in P1 — empty dirs aren't trackable and speculative files violate YAGNI. The depcruise rules for them are still written now (Task 7) so they're enforced from each folder's first file.

---

### Task 1: Toolchain + seed module (`core/errors`)

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`, `biome.json`
- Create: `src/core/errors/soft_error.ts`, `src/core/errors/index.ts`
- Test: `src/core/errors/soft_error.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SoftError extends Error { scope: string }` with ctor `(scope: string, message: string, options?: { cause?: unknown })`; `isSoftError(err: unknown): err is SoftError`. Later phases: throw `SoftError` for one-URL/company/board casualties; anything else fails a stage loudly (spec §7).

- [ ] **Step 1: Branch off main-v2**

```bash
git checkout main-v2 && git checkout -b feat/v2-p1-skeleton
```

- [ ] **Step 2: Update package.json**

Replace `engines` and `scripts` blocks; leave `dependencies` for now (Step 3 installs). Final state of the two blocks:

```json
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "test": "node --test scripts/ src/",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src",
    "boundaries": "depcruise src",
    "check": "npm run typecheck && npm run lint && npm run boundaries && npm test",
    "init": "node scripts/setup/init.js",
    "meta": "node scripts/setup/generate_meta.js",
    "reconcile": "node scripts/notion/cache.js",
    "filter": "node scripts/pipeline/filter.js",
    "dedup": "node scripts/pipeline/dedup.js",
    "rank": "node scripts/pipeline/rank.js",
    "sync": "node scripts/notion/notion_sync.js",
    "release": "node scripts/ops/release.js"
  },
```

- [ ] **Step 3: Install dependencies**

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install zod@^4
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -D typescript@^7 @types/node@^24 @biomejs/biome dependency-cruiser
node --version   # must print v24.x or later — abort and install Node 24 if not
```

Fallback: if `typescript@^7` does not resolve on npm, install `-D @typescript/native-preview` instead and set `"typecheck": "tsgo --noEmit"`. Record whichever landed in the Task 8 doc update.

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["esnext"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.1.0/schema.json",
  "files": { "includes": ["src/**"] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 90
  },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single" } }
}
```

If the installed Biome major rejects this schema, run `npx biome migrate --write` and keep the migrated file.

- [ ] **Step 6: Write the failing test**

`src/core/errors/soft_error.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoftError, isSoftError } from './soft_error.ts';

test('SoftError carries scope, message, cause and name', () => {
  const cause = new Error('boom');
  const err = new SoftError('url', 'card harvest failed', { cause });
  assert.equal(err.scope, 'url');
  assert.equal(err.message, 'card harvest failed');
  assert.equal(err.name, 'SoftError');
  assert.equal(err.cause, cause);
  assert.ok(err instanceof Error);
});

test('isSoftError narrows only SoftError instances', () => {
  assert.equal(isSoftError(new SoftError('board', 'x')), true);
  assert.equal(isSoftError(new Error('x')), false);
  assert.equal(isSoftError('x'), false);
  assert.equal(isSoftError(undefined), false);
});
```

- [ ] **Step 7: Run test to verify it fails**

```bash
node --test src/
```

Expected: FAIL — `Cannot find module ... soft_error.ts`.

- [ ] **Step 8: Implement**

`src/core/errors/soft_error.ts`:

```ts
/**
 * Error taxonomy (spec §7). SoftError marks a narrow casualty — one URL,
 * one company, one board: the runner records it and the run continues, so
 * breadth survives. Any other thrown error fails the stage loudly.
 */
export class SoftError extends Error {
  override readonly name = 'SoftError';
  readonly scope: string;

  constructor(scope: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.scope = scope;
  }
}

export function isSoftError(err: unknown): err is SoftError {
  return err instanceof SoftError;
}
```

`src/core/errors/index.ts`:

```ts
export { SoftError, isSoftError } from './soft_error.ts';
```

- [ ] **Step 9: Verify everything passes**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: typecheck clean, lint clean, all v0 `scripts/` tests still pass, plus 2 new passing tests. (No `boundaries` yet — config comes in Task 7.)

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json biome.json src/core/errors/
git commit -m "feat(v2): toolchain (TS7, biome, node:test on src/) + core/errors seed"
```

---

### Task 2: `core/jd` — the universal JD schema

**Files:**
- Create: `src/core/jd/schema.ts`
- Test: `src/core/jd/schema.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces (exact export names later phases import): zod schemas `JDSchema`, `IdentitySchema`, `ContentSchema`, `StructuredSchema`, `EvaluationSchema`, `VerdictSchema`, `SyncStateSchema`, `WorkTypeSchema`, `LocationSchema`, `TitlePartsSchema`; types `JD`, `Verdict`, `WorkType`; staged types `SourcedJD` (`JD & {content}`), `StructuredJD` (`JD & {structured}`), `EvaluatedJD` (`StructuredJD & {evaluation}`), `SyncedJD` (`JD & {sync}`). Stage signatures in P3+ use the staged types to require inputs at compile time.

- [ ] **Step 1: Write the failing test**

`src/core/jd/schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JDSchema, VerdictSchema } from './schema.ts';

const identity = {
  id: 'li-4021337',
  lane: 'linkedin',
  url: 'https://www.linkedin.com/jobs/view/4021337',
  company: 'Acme Corp',
  title: 'Senior Frontend Engineer',
  scrapedAt: '2026-07-21T09:00:00.000Z',
};

test('minimal JD (identity only) parses; optional sections stay absent', () => {
  const jd = JDSchema.parse({ identity });
  assert.equal(jd.identity.company, 'Acme Corp');
  assert.equal(jd.content, undefined);
  assert.equal(jd.structured, undefined);
});

test('full JD parses and evaluation.matchReasons defaults to []', () => {
  const jd = JDSchema.parse({
    identity,
    content: { rawText: 'We are hiring...' },
    structured: {
      titleParts: { domain: 'frontend', seniority: 'senior', func: 'engineer' },
      locations: [{ city: 'Chennai', country: 'IN' }],
      workType: 'hybrid',
      skills: ['react', 'typescript'],
    },
    evaluation: {
      verdicts: [{ rule: 'title.domain', severity: 'hard', pass: true }],
      score: 82,
    },
    sync: { pageId: 'abc123', syncedAt: '2026-07-21T09:05:00.000Z' },
  });
  assert.deepEqual(jd.evaluation?.matchReasons, []);
  assert.equal(jd.structured?.workType, 'hybrid');
});

test('rejects bad url, bad severity, out-of-range score, empty rawText', () => {
  assert.throws(() => JDSchema.parse({ identity: { ...identity, url: 'not-a-url' } }));
  assert.throws(() =>
    VerdictSchema.parse({ rule: 'x', severity: 'fatal', pass: false }),
  );
  assert.throws(() =>
    JDSchema.parse({ identity, evaluation: { verdicts: [], score: 101 } }),
  );
  assert.throws(() => JDSchema.parse({ identity, content: { rawText: '' } }));
});

test('rejects a JD with no identity', () => {
  assert.throws(() => JDSchema.parse({ content: { rawText: 'x' } }));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test src/core/jd/
```

Expected: FAIL — `Cannot find module ... schema.ts`.

- [ ] **Step 3: Implement**

`src/core/jd/schema.ts`:

```ts
import { z } from 'zod';

/**
 * The universal JD (spec §4): the only definition of a job in the
 * codebase. One record, filled progressively —
 * identity (lane) → content (fetch) → structured (LLM) →
 * evaluation (filter/dedup/rank) → sync (connector).
 * zod re-validates only at ingress boundaries (lane output, LLM output,
 * connector reads); internal stage handoffs trust these types.
 */

export const WorkTypeSchema = z.enum(['onsite', 'hybrid', 'remote']);

export const IdentitySchema = z.object({
  id: z.string().min(1),
  lane: z.string().min(1),
  url: z.url(),
  company: z.string().min(1),
  title: z.string().min(1),
  postedAt: z.iso.date().optional(),
  scrapedAt: z.iso.datetime(),
});

export const ContentSchema = z.object({
  rawText: z.string().min(1),
});

export const TitlePartsSchema = z.object({
  domain: z.string().optional(),
  seniority: z.string().optional(),
  func: z.string().optional(),
});

export const LocationSchema = z.object({
  city: z.string().min(1),
  country: z.string().optional(),
});

export const StructuredSchema = z.object({
  titleParts: TitlePartsSchema,
  locations: z.array(LocationSchema),
  workType: WorkTypeSchema.optional(),
  timezone: z.string().optional(),
  skills: z.array(z.string()),
  salary: z.string().optional(),
});

export const VerdictSchema = z.object({
  rule: z.string().min(1),
  severity: z.enum(['hard', 'soft']),
  pass: z.boolean(),
  detail: z.string().optional(),
});

export const EvaluationSchema = z.object({
  verdicts: z.array(VerdictSchema),
  duplicateOf: z.string().optional(),
  score: z.number().min(0).max(100).optional(),
  excitement: z.string().optional(),
  matchReasons: z.array(z.string()).default([]),
});

export const SyncStateSchema = z.object({
  pageId: z.string().min(1),
  syncedAt: z.iso.datetime(),
});

export const JDSchema = z.object({
  identity: IdentitySchema,
  content: ContentSchema.optional(),
  structured: StructuredSchema.optional(),
  evaluation: EvaluationSchema.optional(),
  sync: SyncStateSchema.optional(),
});

export type WorkType = z.infer<typeof WorkTypeSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type JD = z.infer<typeof JDSchema>;

/** Staged shapes — stage signatures require their inputs at compile time. */
export type SourcedJD = JD & { content: z.infer<typeof ContentSchema> };
export type StructuredJD = JD & { structured: z.infer<typeof StructuredSchema> };
export type EvaluatedJD = StructuredJD & {
  evaluation: z.infer<typeof EvaluationSchema>;
};
export type SyncedJD = JD & { sync: z.infer<typeof SyncStateSchema> };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test src/core/jd/ && npm run typecheck
```

Expected: 4 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/jd/
git commit -m "feat(v2): universal JD schema with staged types (core/jd)"
```

---

### Task 3: `core/jd` — normalizer + public surface

**Files:**
- Create: `src/core/jd/normalize.ts`, `src/core/jd/index.ts`
- Test: `src/core/jd/normalize.test.ts`

**Interfaces:**
- Consumes: nothing (pure string functions).
- Produces: `normalizeToken(input: string): string` (matching form: lowercase, letters+digits only — "Front-End" ≡ "frontend"); `companyKey(name: string): string` (registry key, spec §5: "Acme Corp Pvt Ltd" → "acme-corp"). `index.ts` re-exports all of Task 2 + these — **all cross-module imports of core/jd go through `core/jd/index.ts`**.

- [ ] **Step 1: Write the failing test**

`src/core/jd/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey, normalizeToken } from './normalize.ts';

test('normalizeToken folds case, hyphens, spaces and punctuation', () => {
  assert.equal(normalizeToken('Front-End'), 'frontend');
  assert.equal(normalizeToken('  Full Stack '), 'fullstack');
  assert.equal(normalizeToken('UI/UX'), 'uiux');
  assert.equal(normalizeToken('Node.js'), 'nodejs');
});

test('companyKey drops legal suffixes and hyphenates', () => {
  assert.equal(companyKey('Acme Corp Pvt Ltd'), 'acme-corp');
  assert.equal(companyKey('Groww'), 'groww');
  assert.equal(companyKey('Stripe, Inc.'), 'stripe');
  assert.equal(companyKey('Bosch GmbH'), 'bosch');
});

test('companyKey never strips a single-word name', () => {
  assert.equal(companyKey('Ltd'), 'ltd');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test src/core/jd/
```

Expected: normalize tests FAIL (module not found); schema tests still pass.

- [ ] **Step 3: Implement**

`src/core/jd/normalize.ts`:

```ts
/**
 * Matching semantics (spec §6): case-insensitive, token-normalized.
 * Synonyms live in profile config, never in code.
 */

/** Fold a string to its matching form: lowercase, letters and digits only. */
export function normalizeToken(input: string): string {
  return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const LEGAL_SUFFIXES = new Set([
  'pvt',
  'ltd',
  'limited',
  'private',
  'inc',
  'incorporated',
  'llc',
  'llp',
  'gmbh',
]);

/** Company registry key (spec §5): "Acme Corp Pvt Ltd" → "acme-corp". */
export function companyKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (last === undefined || !LEGAL_SUFFIXES.has(last)) break;
    words.pop();
  }
  return words.join('-');
}
```

`src/core/jd/index.ts`:

```ts
export * from './schema.ts';
export * from './normalize.ts';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test src/core/jd/ && npm run typecheck && npm run lint
```

Expected: all PASS, typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/jd/
git commit -m "feat(v2): token normalizer + companyKey; core/jd public surface"
```

---

### Task 4: `core/config` — pipeline config schema

**Files:**
- Create: `src/core/config/schema.ts`, `src/core/config/index.ts`
- Test: `src/core/config/schema.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: `PipelineConfigSchema` (zod), type `PipelineConfig`, `ScheduleSchema`. Contract (spec §3): core owns *what is enabled* — `lanes: string[]`, `connector: string`, `notifiers: string[]`, `routines: string[]`, `schedule?: { times: 'HH:MM'[] }`, `settings: Record<string, unknown>`. Adapter-specific shapes live under `settings.<adapterName>` and are validated by that adapter at wire time (`cli/wire.ts`, P8) — core never knows them.

- [ ] **Step 1: Write the failing test**

`src/core/config/schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineConfigSchema } from './schema.ts';

test('minimal config gets defaults', () => {
  const cfg = PipelineConfigSchema.parse({ connector: 'notion' });
  assert.deepEqual(cfg.lanes, []);
  assert.deepEqual(cfg.notifiers, []);
  assert.deepEqual(cfg.routines, []);
  assert.deepEqual(cfg.settings, {});
  assert.equal(cfg.schedule, undefined);
});

test('full config parses; adapter settings pass through opaquely', () => {
  const cfg = PipelineConfigSchema.parse({
    lanes: ['linkedin', 'greenhouse', 'keka'],
    connector: 'notion',
    notifiers: ['telegram'],
    routines: ['cleanup'],
    schedule: { times: ['07:30', '18:00'] },
    settings: { notion: { dbId: 'abc' }, telegram: { chatId: 42 } },
  });
  assert.equal(cfg.lanes.length, 3);
  assert.deepEqual(cfg.settings['notion'], { dbId: 'abc' });
});

test('rejects missing connector and malformed schedule times', () => {
  assert.throws(() => PipelineConfigSchema.parse({}));
  assert.throws(() =>
    PipelineConfigSchema.parse({ connector: 'notion', schedule: { times: ['7:30'] } }),
  );
  assert.throws(() =>
    PipelineConfigSchema.parse({ connector: 'notion', schedule: { times: ['25:00'] } }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test src/core/config/
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/core/config/schema.ts`:

```ts
import { z } from 'zod';

/**
 * Per-profile pipeline config (spec §3): core owns WHAT is enabled;
 * adapters own their own settings shape, validated at wire time
 * (cli/wire.ts is the single composition point). Config is the wiring —
 * nothing else decides which adapters run.
 */

export const ScheduleSchema = z.object({
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')),
});

export const PipelineConfigSchema = z.object({
  lanes: z.array(z.string().min(1)).default([]),
  connector: z.string().min(1),
  notifiers: z.array(z.string().min(1)).default([]),
  routines: z.array(z.string().min(1)).default([]),
  schedule: ScheduleSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
```

`src/core/config/index.ts`:

```ts
export * from './schema.ts';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test src/core/config/ && npm run typecheck
```

Expected: 3 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/config/
git commit -m "feat(v2): pipeline config schema — enabled adapters + opaque settings"
```

---

### Task 5: `core/profile` — resume + skill classification schemas

**Files:**
- Create: `src/core/profile/schema.ts`, `src/core/profile/index.ts`
- Test: `src/core/profile/schema.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: `ResumeSchema`, `SkillClassificationSchema`, `ExperienceSchema`; types `Resume`, `SkillClassification`. Contract (spec §6): `resume.json` is hand-maintained (PDF→JSON is a one-time setup seed, P8); `profile build` (P8) classifies skills primary/secondary and seeds filter + rank config — filling gaps, never clobbering. P1 ships shapes only, no seeding logic.

- [ ] **Step 1: Write the failing test**

`src/core/profile/schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResumeSchema, SkillClassificationSchema } from './schema.ts';

test('resume parses with defaults', () => {
  const r = ResumeSchema.parse({
    name: 'Rajni Fixture',
    skills: ['react', 'typescript', 'node'],
  });
  assert.deepEqual(r.experience, []);
  assert.equal(r.headline, undefined);
});

test('rejects empty skills and nameless resume', () => {
  assert.throws(() => ResumeSchema.parse({ name: 'X', skills: [] }));
  assert.throws(() => ResumeSchema.parse({ skills: ['react'] }));
});

test('skill classification parses', () => {
  const c = SkillClassificationSchema.parse({
    primary: ['react', 'typescript'],
    secondary: ['graphql'],
  });
  assert.equal(c.primary.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test src/core/profile/
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/core/profile/schema.ts`:

```ts
import { z } from 'zod';

/**
 * Profile shapes (spec §6). resume.json is the hand-maintained source of
 * truth — PDF parsing is a one-time setup seed, never in the daily path.
 * Skill classification (primary/secondary) is produced by `profile build`
 * and seeds filter skills.core and rank weights: seeding fills gaps,
 * never clobbers user-tuned values.
 */

export const ExperienceSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  years: z.number().positive().optional(),
});

export const ResumeSchema = z.object({
  name: z.string().min(1),
  headline: z.string().optional(),
  skills: z.array(z.string().min(1)).min(1),
  experience: z.array(ExperienceSchema).default([]),
});

export const SkillClassificationSchema = z.object({
  primary: z.array(z.string().min(1)),
  secondary: z.array(z.string().min(1)),
});

export type Resume = z.infer<typeof ResumeSchema>;
export type SkillClassification = z.infer<typeof SkillClassificationSchema>;
```

`src/core/profile/index.ts`:

```ts
export * from './schema.ts';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test src/core/profile/ && npm run typecheck
```

Expected: 3 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/profile/
git commit -m "feat(v2): resume + skill classification schemas (core/profile)"
```

---

### Task 6: `ports/*` — the seven contracts

**Files:**
- Create: `src/ports/context.ts`, `src/ports/connector.ts`, `src/ports/lane.ts`, `src/ports/notifier.ts`, `src/ports/llm.ts`, `src/ports/browser.ts`, `src/ports/scheduler.ts`, `src/ports/storage.ts`, `src/ports/index.ts`
- Test: `src/ports/contracts.test.ts`

**Interfaces:**
- Consumes: `JD`, `SyncedJD` from `../core/jd/index.ts`; `ZodType` from `zod`.
- Produces: every port interface below, exactly as written — these are the contracts P3–P8 implement and the pipeline consumes. Extending a port later is a deliberate PR to the port file, reviewed against the spec.

- [ ] **Step 1: Write the port files** (interfaces have no runtime; the test in Step 2 proves implementability)

`src/ports/context.ts`:

```ts
/**
 * Minimal execution context adapters receive. The full pipeline ctx (P3)
 * extends this — ports must never depend on pipeline/.
 */
export type LogData = Record<string, unknown>;

export interface Logger {
  debug(msg: string, data?: LogData): void;
  info(msg: string, data?: LogData): void;
  warn(msg: string, data?: LogData): void;
  error(msg: string, data?: LogData): void;
}

export interface RunContext {
  profile: string;
  /** Deadline/cancellation — every network/CDP call must honor it. */
  signal: AbortSignal;
  logger: Logger;
  /** Heartbeat tick — long operations must call this (watchdog, spec §7). */
  beat(): void;
}
```

`src/ports/connector.ts`:

```ts
import type { JD, SyncedJD } from '../core/jd/index.ts';
import type { RunContext } from './context.ts';

export interface CacheEntry {
  id: string;
  company: string;
  title: string;
  pageId: string;
}

/** Archive policy consumed by the cleanup routine (spec §3). */
export interface ArchivePolicy {
  passedOlderThanDays: number;
  untouchedOlderThanDays: number;
}

/** External DB persisting pipeline output. The DB is the source of truth. */
export interface Connector {
  readonly name: string;
  /** Rebuild the local cache from the live DB — strictly read-only on it. */
  rebuildCache(ctx: RunContext): Promise<CacheEntry[]>;
  /** Writes automated fields only, never user-edited ones. */
  syncJobs(jobs: JD[], ctx: RunContext): Promise<SyncedJD[]>;
  /** Returns the number of records archived. */
  archiveStale(policy: ArchivePolicy, ctx: RunContext): Promise<number>;
}
```

`src/ports/lane.ts`:

```ts
import type { JD } from '../core/jd/index.ts';
import type { RunContext } from './context.ts';

export type ProbeResult =
  | { status: 'found'; boardRef: string }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/** Browser-driven sourcing. The card gate (filter evaluateCard) runs
 * inside the lane BEFORE a JD is opened — token/browser economy, spec §4. */
export interface FarmingLane {
  readonly kind: 'farming';
  readonly name: string;
  source(ctx: RunContext): Promise<{ jobs: JD[]; companiesSeen: string[] }>;
}

/** Keyless ATS API sourcing, driven by the generic probe/fetch loop (P5). */
export interface ApiLane {
  readonly kind: 'api';
  readonly name: string;
  probe(company: string, ctx: RunContext): Promise<ProbeResult>;
  fetchBoard(boardRef: string, ctx: RunContext): Promise<JD[]>;
}

export type Lane = FarmingLane | ApiLane;
```

`src/ports/notifier.ts`:

```ts
export type NotifyEvent =
  | { kind: 'digest'; profile: string; text: string }
  | { kind: 'alert'; profile: string; text: string };

/** The runner is the single digest sender (spec §7); alerts are rare
 * urgent mid-run events (e.g. login expired). */
export interface Notifier {
  readonly name: string;
  send(event: NotifyEvent): Promise<void>;
}
```

`src/ports/llm.ts`:

```ts
export interface LlmProvider {
  readonly name: string;
  complete(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
}
```

`src/ports/browser.ts`:

```ts
import type { RunContext } from './context.ts';

/**
 * Lifecycle surface only. P4 extends this with page operations once the
 * LinkedIn lane's real needs are known — do not speculate here.
 */
export interface BrowserProvider {
  readonly name: string;
  launch(ctx: RunContext): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  readonly cdpUrl: string;
  close(): Promise<void>;
}
```

`src/ports/scheduler.ts`:

```ts
export interface ScheduledJob {
  profile: string;
  /** HH:MM, 24h, machine-local time. */
  time: string;
}

export interface Scheduler {
  readonly name: string;
  install(jobs: ScheduledJob[]): Promise<void>;
  remove(profile: string): Promise<void>;
  list(): Promise<ScheduledJob[]>;
}
```

`src/ports/storage.ts`:

```ts
import type { ZodType } from 'zod';

/**
 * Run-state I/O (checkpoints, registry, caches). Paths are relative to
 * the profile's data dir; the runner (P3) provides the rooted impl.
 */
export interface Storage {
  /** undefined when the file does not exist; throws on schema mismatch. */
  readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined>;
  writeJson(relPath: string, value: unknown): Promise<void>;
}
```

`src/ports/index.ts`:

```ts
export * from './context.ts';
export * from './connector.ts';
export * from './lane.ts';
export * from './notifier.ts';
export * from './llm.ts';
export * from './browser.ts';
export * from './scheduler.ts';
export * from './storage.ts';
```

- [ ] **Step 2: Write the contract-exercise test**

`src/ports/contracts.test.ts` — in-memory fakes prove every port is implementable and the shapes compose; this file is also the reference example for later adapter authors:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JDSchema } from '../core/jd/index.ts';
import type { JD, SyncedJD } from '../core/jd/index.ts';
import type {
  ApiLane,
  Connector,
  FarmingLane,
  Lane,
  Notifier,
  RunContext,
} from './index.ts';

function fakeCtx(): RunContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(5_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
  };
}

function fakeJD(id: string): JD {
  return JDSchema.parse({
    identity: {
      id,
      lane: 'fake',
      url: 'https://example.com/jobs/1',
      company: 'Acme',
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  });
}

test('a farming lane and an api lane both satisfy Lane', async () => {
  const farming: FarmingLane = {
    kind: 'farming',
    name: 'fake-farm',
    async source() {
      return { jobs: [fakeJD('f-1')], companiesSeen: ['Acme'] };
    },
  };
  const api: ApiLane = {
    kind: 'api',
    name: 'fake-api',
    async probe(company) {
      return company === 'Acme'
        ? { status: 'found', boardRef: 'acme' }
        : { status: 'not-found' };
    },
    async fetchBoard() {
      return [fakeJD('a-1')];
    },
  };
  const lanes: Lane[] = [farming, api];
  const { jobs, companiesSeen } = await farming.source(fakeCtx());
  assert.equal(jobs.length, 1);
  assert.deepEqual(companiesSeen, ['Acme']);
  const probed = await api.probe('Acme', fakeCtx());
  assert.equal(probed.status, 'found');
  assert.equal(lanes.length, 2);
});

test('a connector satisfies Connector and round-trips sync state', async () => {
  const connector: Connector = {
    name: 'fake-db',
    async rebuildCache() {
      return [{ id: 'f-1', company: 'Acme', title: 'FE', pageId: 'p1' }];
    },
    async syncJobs(jobs) {
      return jobs.map(
        (jd): SyncedJD => ({
          ...jd,
          sync: { pageId: `page-${jd.identity.id}`, syncedAt: '2026-07-21T09:05:00.000Z' },
        }),
      );
    },
    async archiveStale() {
      return 0;
    },
  };
  const synced = await connector.syncJobs([fakeJD('f-1')], fakeCtx());
  assert.equal(synced[0]?.sync.pageId, 'page-f-1');
});

test('a notifier satisfies Notifier', async () => {
  const sent: string[] = [];
  const notifier: Notifier = {
    name: 'fake-notify',
    async send(event) {
      sent.push(`${event.kind}:${event.profile}`);
    },
  };
  await notifier.send({ kind: 'digest', profile: 'rajni', text: 'hi' });
  assert.deepEqual(sent, ['digest:rajni']);
});
```

- [ ] **Step 3: Run test to verify it passes**

```bash
node --test src/ports/ && npm run typecheck && npm run lint
```

Expected: 3 tests PASS; typecheck and lint clean. (These fail only if the interfaces are inconsistent — that's the point.)

- [ ] **Step 4: Commit**

```bash
git add src/ports/
git commit -m "feat(v2): all seven port contracts + implementability test"
```

---

### Task 7: Boundary enforcement (dependency-cruiser)

**Files:**
- Create: `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: the `src/` layout from Tasks 1–6.
- Produces: `npm run boundaries` — the mechanical form of the one-way dependency rule; CI fails on any violation from any folder's first file onward.

- [ ] **Step 1: Create `.dependency-cruiser.cjs`**

```js
/**
 * Mechanical enforcement of the one-way dependency rule (main-v2.md
 * coding principles): cli → pipeline/routines/ops → ports + core;
 * adapters → ports + core. Run via `npm run boundaries`.
 */
module.exports = {
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src',
    tsConfig: { fileName: 'tsconfig.json' },
  },
  forbidden: [
    {
      name: 'core-is-pure',
      severity: 'error',
      comment: 'core imports nothing from other layers',
      from: { path: '^src/core' },
      to: { path: '^src/(ports|adapters|pipeline|routines|ops|cli)' },
    },
    {
      name: 'ports-only-core',
      severity: 'error',
      from: { path: '^src/ports' },
      to: { path: '^src/(adapters|pipeline|routines|ops|cli)' },
    },
    {
      name: 'adapters-no-cross-family',
      severity: 'error',
      comment: 'adapters never import each other',
      from: { path: '^src/adapters/([^/]+/[^/]+)/' },
      to: { path: '^src/adapters/', pathNot: '^src/adapters/$1/' },
    },
    {
      name: 'adapters-only-ports-core',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^src/(pipeline|routines|ops|cli)' },
    },
    {
      name: 'only-wire-imports-adapters',
      severity: 'error',
      comment: 'cli/wire.ts is the single composition point',
      from: {
        path: '^src/(pipeline|routines|ops|cli)',
        pathNot: '^src/cli/wire\\.ts$',
      },
      to: { path: '^src/adapters' },
    },
    {
      name: 'nothing-imports-cli',
      severity: 'error',
      from: { path: '^src/(core|ports|adapters|pipeline|routines|ops)' },
      to: { path: '^src/cli' },
    },
  ],
};
```

- [ ] **Step 2: Verify clean pass**

```bash
npm run boundaries
```

Expected: `no dependency violations found` (exit 0).

- [ ] **Step 3: Verify the rules actually fire**

Temporarily add to the top of `src/core/errors/soft_error.ts`:

```ts
import type { Logger } from '../../ports/context.ts';
```

```bash
npm run boundaries
```

Expected: FAIL — one `core-is-pure` error naming `soft_error.ts → ports/context.ts`. Then **revert the line**:

```bash
git checkout -- src/core/errors/soft_error.ts && npm run boundaries
```

Expected: clean again.

- [ ] **Step 4: Full check now green end-to-end**

```bash
npm run check
```

Expected: typecheck + lint + boundaries + all tests (v0 `scripts/` and v2 `src/`) PASS.

- [ ] **Step 5: Commit**

```bash
git add .dependency-cruiser.cjs
git commit -m "feat(v2): depcruise boundary rules — one-way dependencies enforced"
```

---

### Task 8: CI + docs

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `main-v2.md` (phase status), `CLAUDE.md` (one pointer section)

**Interfaces:**
- Consumes: `npm run typecheck | lint | boundaries | test` from Tasks 1–7.
- Produces: the `test` check gating PRs into `main-v2` (and later `main`); agent-facing docs that point at the v2 tree.

- [ ] **Step 1: Update `.github/workflows/test.yml`** (full replacement)

```yaml
name: test

on:
  pull_request:
  push:
    branches: [main, main-v2]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      # Tests never launch a browser — skip Playwright's ~300MB browser download.
      - run: npm ci
        env:
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run boundaries
      - run: npm test
```

- [ ] **Step 2: Update `main-v2.md`**

Under the `## Design sections` block at the end, append:

```markdown

## Phase status

- ✅ P1 skeleton + contracts — toolchain (Node 24, TS7, biome, depcruise),
  core/errors, core/jd (schema + normalizer), core/config, core/profile,
  all seven ports, boundary rules, CI. `npm run check` is the gate.
- ⏳ P2 filter engine — next.
```

(If Task 1 fell back to `@typescript/native-preview`/`tsgo`, say so on the P1 line.)

- [ ] **Step 3: Add the pointer section to `CLAUDE.md`**

Insert directly after the `## What this is` section:

```markdown
## v2 rewrite in progress (branch main-v2)

A clean-room TypeScript rewrite lives under `src/` — decision log in
`main-v2.md` (read it before any v2 work), spec in
`docs/superpowers/specs/2026-07-21-main-v2-architecture-design.md`.
v0 under `scripts/` remains the running pipeline until parity cutover —
don't mix the trees. Gate for v2 changes: `npm run check`
(typecheck + biome + depcruise + all tests).
```

- [ ] **Step 4: Verify local gate one last time**

```bash
npm run check
```

Expected: all green.

- [ ] **Step 5: Commit and open the PR into main-v2**

```bash
git add .github/workflows/test.yml main-v2.md CLAUDE.md
git commit -m "feat(v2): CI gate (typecheck+lint+boundaries+test on node 24) + docs"
git push -u origin feat/v2-p1-skeleton
gh pr create --base main-v2 --title "v2 P1: skeleton + contracts" --body "$(cat <<'EOF'
Phase P1 of the v2 clean-room rewrite (spec: docs/superpowers/specs/2026-07-21-main-v2-architecture-design.md).

- Toolchain: Node 24 type-stripping, TS7 --noEmit, biome, dependency-cruiser
- core/errors, core/jd (universal JD schema + normalizer), core/config, core/profile
- All seven port contracts + implementability test
- One-way dependency rules enforced; CI runs typecheck+lint+boundaries+test

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens; `test` check goes green.
