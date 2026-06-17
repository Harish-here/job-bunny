---
description: Run the Playwright-over-CDP extractor — collect job cards + JD raw text into jobs_raw_text.json.
---

Run the extraction stage (browser, LLM-free):

```bash
node scripts/extract.js
```

Prerequisites (checked by `/doctor`): Chrome running with `--remote-debugging-port=9222` and an active LinkedIn login; every page-type in `search_urls.md` has a `page_inventory/<page>.md`. extract.js is **config-driven** — it reads selectors/behavior from the inventory files at runtime. It applies the Stage A avoid-list drop on card data before opening JDs. On a page-group assertion failure it skips that group and continues. Output: `jobs_raw_text.json`.
