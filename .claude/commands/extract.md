---
description: Run the Playwright-over-CDP extractor — collect job cards + JD raw text into jobs_raw_text.json.
---

Run the extraction stage (browser, LLM-free). If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/extract.js   # with profile argument
node scripts/extract.js                              # default profile / legacy
```

Prerequisites (checked by `/doctor`): Chrome running with `--remote-debugging-port=9222` and an active LinkedIn login; every page-type in the profile's `search_urls.md` has a `page_inventory/<page>.md` (inventories are shared across profiles). extract.js is **config-driven** — it reads selectors/behavior from the inventory files at runtime. It applies the Stage A avoid-list drop (profile's `avoid.md`) on card data before opening JDs. On a page-group assertion failure it skips that group and continues. Output: the profile's `data/jobs_raw_text.json`.

Missed a daily run? Widen the search window for just this invocation without touching `search_urls.md` (which stays at its stored `f_TPR=r86400` default):

```bash
JOBBUNNY_WINDOW_HOURS=72 JOBBUNNY_PROFILE=<profile> node scripts/extract.js   # e.g. catch up 3 days
```

This only rewrites relative windows (`f_TPR=r<sec>`); it's an in-memory override for that run only. The existing cache-based dedup already filters out jobs already synced, so widening just costs a bit more scrape/JD time that day, not duplicate Notion rows.
