---
description: Run the Playwright-over-CDP extractor — collect job cards + JD raw text into jobs_raw_text.json.
---

Run the extraction stage (browser, LLM-free). If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/pipeline/extract.js   # with profile argument
node scripts/pipeline/extract.js                              # default profile
```

Chrome is auto-managed — extract.js owns the browser lifecycle end-to-end, no manual step needed. If the debug Chrome isn't already running on `--remote-debugging-port=9222`, extract launches it itself (via `scripts/lib/browser.js`), and it **always** kills it on the way out — success, failure, or Ctrl-C — unless `JOBBUNNY_KEEP_BROWSER=1` (e.g. to inspect a page after selector drift). LinkedIn login persists across runs in the on-disk `.chrome-debug/` profile, so nothing is lost by the kill.

Prerequisites: an active LinkedIn login in `.chrome-debug/`; every page-type in the profile's `search_urls.md` has a `page_inventory/<page>.md` (inventories are shared across profiles). extract.js is **config-driven** — it reads selectors/behavior from the inventory files at runtime. It applies the Stage A avoid-list drop (profile's `avoid.md`) on card data before opening JDs. On a page-group assertion failure it skips that group and continues. Output: the profile's `data/jobs_raw_text.json`.

Per-URL resume: a same-day rerun skips search URLs already completed, tracked in the profile's `data/extract_resume.json` (keyed on the day + a hash of `search_urls.md` + the `JOBBUNNY_WINDOW_HOURS` in effect — changing either invalidates the resume state and starts fresh). A URL is only marked done once its results are flushed, so a failed or interrupted URL is retried on the next run. Force a full fresh scrape (ignore any resume state) with:

```bash
JOBBUNNY_FRESH=1 JOBBUNNY_PROFILE=<profile> node scripts/pipeline/extract.js
```

Observability, under the profile's `data/`: `extract_started.json` (unchanged — written the moment the run starts), `extract_progress.json` (heartbeat, rewritten at every checkpoint with stage/group/url/cards-captured, plus `done: true` once the run finishes), and `logs/extract_<timestamp>.log` (structured per-run log).

Missed a daily run? Widen the search window for just this invocation without touching `search_urls.md` (which stays at its stored `f_TPR=r86400` default):

```bash
JOBBUNNY_WINDOW_HOURS=72 JOBBUNNY_PROFILE=<profile> node scripts/pipeline/extract.js   # e.g. catch up 3 days
```

This only rewrites relative windows (`f_TPR=r<sec>`); it's an in-memory override for that run only. The existing cache-based dedup already filters out jobs already synced, so widening just costs a bit more scrape/JD time that day, not duplicate Notion rows.
