# v2 P4 — Browser + LinkedIn Farming Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.
> **Depends on:** P1 + P2 (`evaluateCard`) + P3 (`StageDef`, `StagePayload`, `FsStorage`, `DoctorCheck`) merged. Owns `ports/browser.ts` for the duration — P5/P6 must not touch it.
> **Highest-risk phase.** Where live-DOM reality contradicts this plan, update the plan + `main-v2.md` in the same PR — the contracts below are the negotiable part; the *invariants* (deadlines, batching, resumability, fail-soft) are not.

**Goal:** Chrome-over-CDP adapter, the LinkedIn farming lane (card harvest → card gate → JD open → raw text), v2 page-inventory schema with freshness doctor check, per-URL resumability.

**Pin at phase start** (discovery — read, don't invent): current selectors from `page_inventory/*.md`; Chrome launch specifics from `scripts/lib/browser.js`; batching/deadline lessons from `scripts/pipeline/extract/*.js` and memory notes (per-card `scrollIntoViewIfNeeded` 30s stalls; exit-137 OOM on JD open).

## Global Constraints

- Branch `feat/v2-p4-linkedin` off `main-v2`. All P1 constraints apply.
- **Every CDP call deadline-bound** via the ctx signal — no unbounded awaits (2026-07-17 lesson).
- Card harvest is **batch in-page** (one evaluate returning all cards), never per-card round-trips.
- Fail-soft granularity: one URL = one `SoftError` recorded in `StagePayload`-adjacent lane report; one broken page-group never kills the lane; the lane itself failing (login dead, Chrome won't launch) is loud.
- DOM drift is fixed by regenerating the inventory (`/page-analyse`), never by editing lane code.
- Runtime verification on `profiles/rajni/` only.

## File Structure

```
src/ports/browser.ts                        EXTEND (Task 1) — PageHandle ops
src/adapters/browser/cdp-chrome/
  launcher.ts + launcher.test.ts            find Chrome, launch w/ CDP, kill on close
  provider.ts + provider.test.ts            CdpChromeProvider implements BrowserProvider
  index.ts
src/adapters/lanes/linkedin/
  inventory.ts + inventory.test.ts          InventorySchema (zod) + loader + freshness
  harvest.ts + harvest.test.ts              batch card extraction from a list page
  jd_open.ts + jd_open.test.ts              open card → raw JD text (per page-type)
  resume_state.ts + resume_state.test.ts    per-URL same-day completion via Storage
  lane.ts + lane.test.ts                    LinkedInLane implements FarmingLane
  index.ts
```

---

### Task 1: Extend `ports/browser.ts` (port-extension PR — reviewed against spec §3)

**Interfaces — Produces (frozen after this task):**

```ts
export interface BrowserProvider {
  readonly name: string;
  launch(ctx: RunContext): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  readonly cdpUrl: string;
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
}

/** Minimal page surface lanes are allowed to use. Every method takes the
 * deadline from the RunContext signal it was created under. */
export interface PageHandle {
  goto(url: string, opts: { timeoutMs: number }): Promise<void>;
  /** Run a function in-page and return its JSON-serializable result —
   * the batch-harvest workhorse. */
  evaluate<T>(fn: string, opts: { timeoutMs: number }): Promise<T>;
  click(selector: string, opts: { timeoutMs: number }): Promise<void>;
  waitFor(selector: string, opts: { timeoutMs: number }): Promise<void>;
  content(opts: { timeoutMs: number }): Promise<string>;
  close(): Promise<void>;
}
```

- [ ] Steps: update port + `contracts.test.ts` fake to satisfy it → `npm run check` → commit `feat(v2): browser port page surface`.

### Task 2: cdp-chrome adapter

**Interfaces:** Produces `CdpChromeProvider` (name `'cdp-chrome'`). Port from `scripts/lib/browser.js` by reading: macOS Chrome path probing, `--remote-debugging-port=9222`, `.chrome-debug/` user-data-dir (persistent LinkedIn login), always-kill-on-close unless `JOBBUNNY_KEEP_BROWSER=1`. Implementation uses `playwright.chromium.connectOverCDP`; every PageHandle method wraps the playwright call in a deadline race off `AbortSignal.timeout(opts.timeoutMs)` combined with the ctx signal.

- [ ] Steps: TDD launcher path-probe + arg construction with fs/spawn fakes (no real Chrome in tests) → TDD PageHandle deadline behavior against a fake playwright page (a hanging `evaluate` rejects at timeoutMs) → implement → **manual smoke on this machine**: scratch script launches real Chrome, opens example.com, closes; confirm process killed → commit `feat(v2): cdp-chrome browser adapter`.

### Task 3: Inventory schema + freshness check

**Interfaces — Produces:**

```ts
export const InventorySchema = z.object({
  page: z.string(),                          // e.g. 'linkedin-search'
  pageType: z.enum(['details-page', 'popup']),   // spec: two-step vs in-page JD
  generatedAt: z.iso.date(),
  selectors: z.object({
    cardList: z.string(), card: z.string(),
    cardTitle: z.string(), cardCompany: z.string(), cardLocation: z.string(),
    cardLink: z.string(),
    jdRoot: z.string(),                      // where raw JD text lives after open
    pagination: z.string().optional(),
  }),
  behaviors: z.record(z.string(), z.string()).default({}),   // free-form notes /page-analyse emits
});
export function loadInventory(storage: Storage, page: string): Promise<Inventory>;
export function inventoryFreshnessCheck(storage: Storage, pages: string[], maxAgeDays: number): DoctorCheck;
```

v2 inventories are **JSON** under `profiles/../page_inventory/` — wait: inventories are machine-shared, not per-profile; they live at repo root `page_inventory/` as today, now as `<page>.json` generated by a v2-updated `/page-analyse`. Freshness: `generatedAt` older than `maxAgeDays` ⇒ `warn`; missing inventory for an enabled page ⇒ `red` (decision 9).

- [ ] Steps: TDD schema + loader + freshness statuses with fixture files → implement → translate the current `page_inventory/*.md` selector tables into `<page>.json` by reading them (values pinned at phase start) → commit `feat(v2): page inventory schema + freshness doctor check`.

### Task 4: Batch card harvest + card gate

**Interfaces:** Produces `harvestCards(page: PageHandle, inv: Inventory, ctx): Promise<CardInput & { url: string; id: string }[]>` — single in-page `evaluate` built from inventory selectors returning all cards; and `gateCards(cards, filterCfg): { pass: Card[]; dropped: DroppedRecord[] }` using P2 `evaluateCard` + `decide` (identity-only JDs for dropped records). LinkedIn job id parsed from card link (`/jobs/view/(\d+)/` → `li-<id>`).

- [ ] Steps: TDD the in-page function builder against fixture DOM strings (jsdom-free: the builder returns a JS source string; test evaluates it with `node:vm` over a minimal `document` stub capturing selector queries) → TDD `gateCards` drop/pass with a real FilterConfig → implement → commit `feat(v2): batch card harvest + card gate`.

### Task 5: JD open + raw text

**Interfaces:** Produces `openJd(page: PageHandle, card, inv: Inventory, ctx): Promise<string>` — popup type: click card title, wait `jdRoot`, extract text; details-page type: `goto` card url, wait `jdRoot`, extract. Each open fully deadline-bound; failure throws `SoftError('url', …)` recorded against that card only.

- [ ] Steps: TDD both page-types against fake PageHandle scripting expected call sequences → implement → commit `feat(v2): JD open (popup + details-page)`.

### Task 6: Resume state

**Interfaces:** Produces `ResumeState` over `Storage` at `registry/extract_resume.json`: `{ date, done: Record<url, count> }` — `shouldSkip(url)`, `markDone(url, count)`, `resetIfNewDay()`, all-done ⇒ rescan reset for multi-fire schedules; **a same-day reset never discards already-flushed captures** (v0 invariant, encode as a test).

- [ ] Steps: TDD (skip when done today; new day resets; all-done triggers rescan; flushed data untouched on reset) → implement → commit `feat(v2): per-URL extract resume state`.

### Task 7: The lane

**Interfaces — Produces (P4 handoff):** `LinkedInLane implements FarmingLane` — ctor `(browser: BrowserProvider, inventories: Inventory[], urls: SearchUrlGroup[], filterCfg: FilterConfig, storage: Storage)`; `source(ctx)` iterates URL groups → harvest → gate → open surviving JDs (`beat()` per card and per JD) → returns `{ jobs, companiesSeen }` where `companiesSeen` = post-gate card companies; per-URL failures collected as SoftErrors in the lane's log, never thrown. `SearchUrlGroup = { page: string; urls: string[] }` parsed from the profile's `search_urls.md` (parser included here, format unchanged from v0).

- [ ] Steps: TDD `source()` orchestration with fakes (URL fails soft → others continue; beat called; resume skips; companiesSeen correct) → implement → **live rajni verify**: real Chrome, one real LinkedIn search URL from the rajni fixture, confirm jobs land with `identity`+`content` and inventory selectors hold (regenerate via `/page-analyse` if drifted) → commit `feat(v2): LinkedIn farming lane` → update `main-v2.md` (P4 ✅) → PR.
