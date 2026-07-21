# v2 P2 — Filter Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.
> **Depends on:** P1 merged into `main-v2`. Consumes ONLY the P1 handoff contract (see `2026-07-21-v2-p0-phases-overview.md`).

**Goal:** `core/filter` complete — one pure engine, per-rule severity, `evaluateCard` (card gate) + `evaluate` (full), replay-tested against recorded v0 decisions.

**Architecture:** Spec §6. Pure functions only; config values come from `profiles/<p>/filter.json` (loaded by callers, never by this module). One file per rule behind one interface.

**Tech Stack:** TypeScript 7 / zod v4 / node:test — per P1 toolchain.

## Global Constraints

- Branch `feat/v2-p2-filter` off `main-v2`; PR back into `main-v2`.
- All P1 global constraints apply (`.ts` import extensions, two-pair rule, index.ts surfaces, colocated tests).
- `core/` purity: no I/O, no env, no imports from ports/adapters/pipeline (depcruise enforces).
- Matching is case-insensitive token-normalized via P1 `normalizeToken`; synonyms live in config lists, never code. `reject` beats `match`. Absent config section ⇒ rule doesn't run.

## File Structure

```
src/core/filter/
  config.ts + config.test.ts     FilterConfigSchema (zod) + FilterConfig
  engine.ts + engine.test.ts     evaluate, evaluateCard, decide, CardInput
  rules/
    types.ts                     Rule interface (no test — types only)
    title.ts + title.test.ts     domain / function / seniority
    company.ts + company.test.ts avoid list (always hard)
    location.ts + location.test.ts
    timezone.ts + timezone.test.ts
    skills.ts + skills.test.ts
  fixtures/replay.json           recorded v0 inputs + expected decisions
  replay.test.ts                 parity gate vs v0
  index.ts                       public surface
```

---

### Task 1: Config schema

**Files:** Create `src/core/filter/config.ts`, test `config.test.ts`.

**Interfaces:**
- Consumes: `zod`, `WorkTypeSchema` from `../jd/index.ts`.
- Produces: `FilterConfigSchema`, `FilterConfig`, `MatchRuleSchema`, `SeveritySchema`.

- [ ] **Step 1: Failing test** — parse the spec §6 example verbatim; defaults (`severity: 'hard'`, empty `reject`); reject unknown workType and negative `minMatch`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilterConfigSchema } from './config.ts';

test('spec §6 example config parses with defaults', () => {
  const cfg = FilterConfigSchema.parse({
    title: {
      domain: { match: ['ui', 'frontend', 'front-end', 'full-stack'] },
      function: { match: ['engineer', 'developer', 'architect'] },
      seniority: { match: ['senior', 'lead', 'staff'], reject: ['intern', 'junior', 'principal'], severity: 'soft' },
    },
    companies: { avoid: ['Evil Corp'] },
    locations: [
      { city: 'chennai', country: 'IN', workTypes: ['onsite', 'hybrid', 'remote'] },
      { city: '*', workTypes: ['remote'] },
    ],
    timezones: { accept: ['APAC', 'EMEA'] },
    skills: { core: ['react', 'typescript'] },
  });
  assert.equal(cfg.title?.domain?.severity, 'hard');
  assert.deepEqual(cfg.title?.domain?.reject, []);
  assert.equal(cfg.skills?.minMatch, 1);
  assert.equal(cfg.timezones?.severity, 'hard');
});

test('empty config is valid — every rule optional', () => {
  const cfg = FilterConfigSchema.parse({});
  assert.equal(cfg.title, undefined);
});

test('rejects bad workType and minMatch < 1', () => {
  assert.throws(() => FilterConfigSchema.parse({ locations: [{ city: 'x', workTypes: ['office'] }] }));
  assert.throws(() => FilterConfigSchema.parse({ skills: { core: ['a'], minMatch: 0 } }));
});
```

- [ ] **Step 2: Run `node --test src/core/filter/` — FAIL (module not found).**
- [ ] **Step 3: Implement**

```ts
import { z } from 'zod';
import { WorkTypeSchema } from '../jd/index.ts';

/** Filter config (spec §6): values live in profiles/<p>/filter.json —
 * this module owns only the shape and defaults. Severity is per-rule:
 * hard ⇒ drop (recorded), soft ⇒ keep + rank penalty. */

export const SeveritySchema = z.enum(['hard', 'soft']);

export const MatchRuleSchema = z.object({
  match: z.array(z.string().min(1)).default([]),
  reject: z.array(z.string().min(1)).default([]),
  severity: SeveritySchema.default('hard'),
});

export const FilterConfigSchema = z.object({
  title: z
    .object({
      domain: MatchRuleSchema.optional(),
      function: MatchRuleSchema.optional(),
      seniority: MatchRuleSchema.optional(),
    })
    .optional(),
  companies: z.object({ avoid: z.array(z.string().min(1)) }).optional(),
  locations: z
    .array(
      z.object({
        city: z.string().min(1),
        country: z.string().optional(),
        workTypes: z.array(WorkTypeSchema).min(1),
      }),
    )
    .optional(),
  timezones: z
    .object({ accept: z.array(z.string().min(1)), severity: SeveritySchema.default('hard') })
    .optional(),
  skills: z
    .object({
      core: z.array(z.string().min(1)),
      minMatch: z.number().int().min(1).default(1),
      severity: SeveritySchema.default('hard'),
    })
    .optional(),
});

export type FilterConfig = z.infer<typeof FilterConfigSchema>;
```

- [ ] **Step 4: Tests pass + typecheck. Commit** `feat(v2): filter config schema`.

---

### Task 2: Rule interface + title rule

**Files:** Create `src/core/filter/rules/types.ts`, `rules/title.ts`, test `rules/title.test.ts`.

**Interfaces:**
- Consumes: `StructuredJD`, `Verdict`, `normalizeToken` from `../../jd/index.ts`; `FilterConfig`.
- Produces:

```ts
// rules/types.ts
import type { StructuredJD, Verdict } from '../../jd/index.ts';
import type { FilterConfig } from '../config.ts';

export interface CardInput {
  title: string;
  company: string;
  location?: string;
}

/** A rule returns undefined when its config section is absent (rule
 * doesn't run) — never a passing verdict for "not configured". */
export interface Rule {
  name: string;
  eval(jd: StructuredJD, cfg: FilterConfig): Verdict[] | undefined;
  /** Card-gate variant using only bare-card fields; omit if the rule
   * needs structured data. */
  evalCard?(card: CardInput, cfg: FilterConfig): Verdict[] | undefined;
}
```

- `titleRule: Rule` emitting verdicts named `title.domain`, `title.function`, `title.seniority`.

- [ ] **Step 1: Failing tests.** Semantics to encode (each its own `test()`):
  - domain pass: normalized title containing any normalized `match` token passes ("Senior Front-End Engineer" vs `['frontend']`).
  - domain fail: no token present ⇒ `pass: false` with configured severity, `detail` lists the missed list.
  - seniority `reject` beats `match`: title containing "Principal" fails even when "senior" also matches.
  - `evalCard` gives identical verdicts from a bare title string.
  - absent `title` config ⇒ `undefined`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Core matcher shared by all three sub-rules:

```ts
import { normalizeToken } from '../../jd/index.ts';
import type { StructuredJD, Verdict } from '../../jd/index.ts';
import type { FilterConfig, MatchRuleSchema } from '../config.ts';
import type { z } from 'zod';
import type { CardInput, Rule } from './types.ts';

type MatchRule = z.infer<typeof MatchRuleSchema>;

function evalMatchRule(name: string, haystack: string, rule: MatchRule): Verdict {
  const folded = normalizeToken(haystack);
  const hit = (list: string[]) => list.some((t) => folded.includes(normalizeToken(t)));
  if (rule.reject.length > 0 && hit(rule.reject)) {
    return { rule: name, severity: rule.severity, pass: false, detail: 'matched reject list' };
  }
  if (rule.match.length > 0 && !hit(rule.match)) {
    return { rule: name, severity: rule.severity, pass: false, detail: `no match in [${rule.match.join(', ')}]` };
  }
  return { rule: name, severity: rule.severity, pass: true };
}

function evalTitleText(title: string, cfg: FilterConfig): Verdict[] | undefined {
  if (!cfg.title) return undefined;
  const out: Verdict[] = [];
  if (cfg.title.domain) out.push(evalMatchRule('title.domain', title, cfg.title.domain));
  if (cfg.title.function) out.push(evalMatchRule('title.function', title, cfg.title.function));
  if (cfg.title.seniority) out.push(evalMatchRule('title.seniority', title, cfg.title.seniority));
  return out.length > 0 ? out : undefined;
}

export const titleRule: Rule = {
  name: 'title',
  eval: (jd, cfg) => evalTitleText(jd.identity.title, cfg),
  evalCard: (card: CardInput, cfg) => evalTitleText(card.title, cfg),
};
```

- [ ] **Step 4: Pass + typecheck. Commit** `feat(v2): title rule (domain/function/seniority)`.

---

### Task 3: Company rule

**Files:** `rules/company.ts` + test.

**Interfaces:** Produces `companyRule: Rule` (verdict `company.avoid`, **severity always `'hard'`** regardless of config — avoid is non-negotiable, spec §6). Uses P1 `companyKey` for comparison so "Evil Corp Pvt Ltd" matches avoid entry "Evil Corp".

- [ ] Steps: failing test (avoid hit fails hard; non-avoid passes; absent `companies` config ⇒ undefined; suffix-insensitive match via `companyKey`) → implement (`evalCard` and `eval` both compare `companyKey(company)` against `companyKey` of each avoid entry) → pass → commit `feat(v2): company avoid rule`.

---

### Task 4: Location, timezone, skills rules

**Files:** `rules/location.ts`, `rules/timezone.ts`, `rules/skills.ts` + one test file each.

**Interfaces:** Produces `locationRule`, `timezoneRule`, `skillsRule` (all `Rule`; no `evalCard` — they need structured data). Exact semantics to encode in tests first:

- `location` (verdict `location.workType`): pass iff **some** `structured.locations` entry is allowed by **some** config entry — a config entry allows it when (`city === '*'` or `normalizeToken(cityA) === normalizeToken(cityB)`) and `structured.workType ∈ entry.workTypes`. `workType` absent on the JD ⇒ verdict passes with `detail: 'workType unknown'` (never drop on missing data — the LLM stage owns extraction quality). Severity: `'hard'` (fixed; per-city severity is YAGNI until a profile needs it).
- `timezone` (verdict `timezone.accept`): runs only when `structured.workType === 'remote'` **and** `structured.timezone` present **and** config section present; pass iff normalized timezone is in normalized `accept` list; severity from config.
- `skills` (verdict `skills.core`): pass iff `|normalized structured.skills ∩ normalized cfg.core| >= minMatch`; `detail` lists the intersection; severity from config.

- [ ] Steps per rule: failing tests covering pass/fail/absent-config/edge (unknown workType; non-remote skips timezone; empty JD skills) → implement → pass → commit (`feat(v2): location rule`, `…timezone rule`, `…skills rule` — three commits).

---

### Task 5: Engine — evaluate / evaluateCard / decide

**Files:** `engine.ts` + `engine.test.ts`, `index.ts`.

**Interfaces:**
- Produces (the P2 handoff contract):

```ts
export const RULES: Rule[];               // title, company, location, timezone, skills
export function evaluate(jd: StructuredJD, cfg: FilterConfig): Verdict[];
export function evaluateCard(card: CardInput, cfg: FilterConfig): Verdict[];
export function decide(verdicts: Verdict[]): 'keep' | 'drop';   // drop ⇔ any !pass && hard
```

`index.ts` re-exports engine + config + `CardInput`.

- [ ] **Step 1: Failing tests:** full-config JD passing all rules ⇒ `decide` keep; hard title fail ⇒ drop; soft seniority fail alone ⇒ keep (verdict recorded for rank); `evaluateCard` runs only title+company; empty config ⇒ `evaluate` returns `[]` and keep.
- [ ] **Step 2: Implement** — `evaluate` concat-maps `RULES` `eval`, `evaluateCard` uses `evalCard` where defined; `decide` is one `some()`.
- [ ] **Step 3: Pass + `npm run check`. Commit** `feat(v2): filter engine — evaluate/evaluateCard/decide`.

---

### Task 6: Replay parity vs v0

**Files:** `fixtures/replay.json`, `replay.test.ts`.

**Interfaces:** Consumes v0 fixture-run artifacts (rajni profile). Produces the P2 parity gate.

- [ ] **Step 1: Generate the fixture.** Run v0 filter on the committed rajni fixture data (`JOBBUNNY_PROFILE=rajni node scripts/pipeline/filter.js` after a `/verify`-style seeded run, or reuse `profiles/rajni/data/` artifacts already present). Build `fixtures/replay.json`: an array of `{ input: <v2 StructuredJD mapped from v0 job fields>, v0Decision: 'keep' | 'drop', v0Reason?: string }` — the mapping script is a one-off Node script written inline in this step and **not committed** (fixture is).
- [ ] **Step 2: Write `replay.test.ts`** — for every fixture row, run `evaluate` + `decide` with the rajni `filter.json` translated from v0 `filter_config.json`; assert decisions match `v0Decision`. Known/intentional divergences (e.g., v2 severity keeping a job v0 dropped) go in an explicit `EXPECTED_DIVERGENCES: string[]` list (job ids) at the top of the test with a comment per entry — empty list preferred, every entry justified.
- [ ] **Step 3: Pass + `npm run check`. Commit** `test(v2): filter replay parity vs v0 fixture`.
- [ ] **Step 4: Update `main-v2.md` Phase status (P2 ✅, note divergence count). PR into `main-v2`.**
