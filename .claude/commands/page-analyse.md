---
description: Browser-driven DOM analysis (Claude in Chrome) — fill/refresh src/adapters/lanes/linkedin/page_inventory/<page>.json so the LinkedIn farming lane can scrape a page-type.
---

Usage: `/page-analyse <page-slug>` (e.g. `linkedin__jobs-search`, `linkedin__jobs-search-results`).

This stage is **browser-driven and runs inline — you (Claude Code) do it directly via Claude in Chrome, not via any script.** The job: inspect a page-type's live DOM and write/refresh `src/adapters/lanes/linkedin/page_inventory/<page>.json`, which `src/adapters/lanes/linkedin/inventory.ts` reads at runtime (config-driven — DOM drift is fixed by editing this JSON, never by editing lane code).

## Procedure

1. **Resolve the page slug → a live URL.** Open the profile's `search_urls.md` and use the **first URL filed under the matching `### <page-slug>` node** — a real saved search renders cards; the bare `/jobs/search/` may be empty. (Slug→path: `linkedin__jobs-search` → `/jobs/search/`, `linkedin__jobs-search-results` → `/jobs/search-results/`; see `resolvePage()` in `src/cli/commands/lane_add_url.ts`.)
2. **Load it in Chrome** (`mcp__claude-in-chrome__*`) using the existing logged-in LinkedIn session — the persistent profile at `.chrome-debug/`. Do not log in fresh.
3. **Inspect the DOM** for the search cards and the JD panel/page: read the live markup (`read_page` / `get_page_text` / `javascript_tool`) and identify the stable selector for each key below. Prefer durable class/attribute selectors over generated/hashed ones.
4. **Write `src/adapters/lanes/linkedin/page_inventory/<page>.json`** matching the schema below exactly. If the file already exists, refresh the changed selector values in place and bump `generatedAt` — don't restructure.

## Output format (`InventorySchema`, `src/adapters/lanes/linkedin/inventory.ts`)

```json
{
  "page": "<page-slug>",
  "pageType": "details-page | popup",
  "generatedAt": "YYYY-MM-DD",
  "selectors": {
    "cardList": "...", "card": "...", "cardTitle": "...", "cardCompany": "...",
    "cardLocation": "...", "cardLink": "...", "jdRoot": "...", "pagination": "... (optional)"
  },
  "behaviors": { "...": "free-form judgement/config keys, e.g. paginationType, jobCardIdAttr, maxRawTextChars" }
}
```

`pageType` is `details-page` when the JD opens via a fresh `/jobs/view/<id>/` navigation, `popup` when it opens in-place in a side panel. Every `selectors` key except `pagination` is required and non-empty — the zod schema itself is the completeness gate: a missing/empty required selector fails `loadInventory()` (thrown loudly at `jobbunny doctor`/`jobbunny run` time), never silently. `behaviors` carries everything else the lane's harvest/gate logic reads as config (pagination cadence, page-size, JD-settled signal, char caps, etc.) — mirror an existing file's keys rather than inventing new ones unless the lane code actually reads a new key.

## After

Run `jobbunny doctor --profile <name>` — the inventory-freshness check (`src/adapters/lanes/linkedin/inventory.ts`'s `inventoryFreshnessCheck`, default staleness ceiling 30 days) must be green before `jobbunny run`.
