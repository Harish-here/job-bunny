---
description: Browser-driven DOM analysis (Claude in Chrome) — fill/refresh page_inventory/<page>.md so extract.js can scrape a page-type.
---

Usage: `/page-analyse <page-slug>` (e.g. `linkedin__jobs-search`, `linkedin__jobs-search-results`).

This stage is **browser-driven and runs inline — you (Claude Code) do it directly via Claude in Chrome, not via a script.** There is no `page_analyse.js`. The job: inspect a page-type's live DOM and write/refresh `page_inventory/<page>.md`, which `extract.js` reads at runtime (config-driven — DOM drift is fixed by editing this file, never by regenerating code).

## Procedure

1. **Resolve the page slug → a live URL.** Open `search_urls.md` and use the **first URL filed under the matching `### <page-slug>` node** — a real saved search renders cards; the bare `/jobs/search/` may be empty. (Slug→path: `linkedin__jobs-search` → `/jobs/search/`, `linkedin__jobs-search-results` → `/jobs/search-results/`; see `resolvePage()` in `scripts/add_url.js`.)
2. **Load it in Chrome** (`mcp__claude-in-chrome__*`) using the existing logged-in LinkedIn session — the persistent profile at `.chrome-debug/`. Do not log in fresh.
3. **Inspect the DOM** for the search cards and the JD panel/page: read the live markup (`read_page` / `get_page_text` / `javascript_tool`) and identify the stable selector for each key below. Prefer durable class/attribute selectors over generated/hashed ones.
4. **Write `page_inventory/<page>.md`** in the exact format below. If the file already exists, refresh the changed selector values in place and update the dateline — don't restructure.

## Output format

Mirror the canonical template **`page_inventory/linkedin__jobs-search.md`** exactly — same sections, same keys, same `- key: value` lines (that is the only line shape `parseInventory()` in `scripts/extract.js` reads):

- `## 1. Behavior (manual)` — `interaction_model`, `job_list_trigger`, `pagination_type`, `pagination_param`, `pagination_page_size`, `max_pages`, `jd_settled_signal`, `url_pattern_of_job`, `jd_anchor_text`, `max_raw_text_chars`. These are judgement/config, not scraped — carry them over from the template unless the page genuinely differs.
- `## 2. Selectors (from live page analysis)` — **Search page**: `job_list_container`, `job_card`, `job_card_title`, `job_card_company`, `job_card_location`, `job_card_href`, `job_card_id_attr`, `scroll_container`, `end_of_results_signal`. **JD panel / page**: `jd_container`, `jd_title`, `jd_company`, `jd_body`, `jd_metadata`.
- `## 3. Assertions (derived from selectors above)` — `must_exist` (the list container) and `min_job_cards`.

**Completeness gate:** the file must define every key `extract.js` consumes — at minimum the `REQUIRED_SELECTORS` it validates (`job_card`, `job_card_title`, `job_card_company`, `jd_body`; see `validateInventory()`). A blank/missing required selector makes `/doctor` and `/extract` throw. `job_card_href` may be left blank when the card exposes the id via `job_card_id_attr` + `url_pattern_of_job`.

## After

Run `/doctor` — the inventory check (`scripts/doctor.js`) must be green before `/run` or `/extract`.
