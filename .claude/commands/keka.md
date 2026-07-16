---
description: Keka careers API lane — probes new companies seen by /extract, fetches curated/auto-discovered tenant boards, merges into jobs_raw_text.json. Optional, fail-soft.
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/pipeline/keka.js   # with profile argument
node scripts/pipeline/keka.js                               # default profile
```

A second, keyless discovery channel alongside LinkedIn: no browser, no login, just Keka's public keyless careers API. Reads the profile's `keka_boards.md` — if it's absent, the lane is disabled and the script exits 0 (nothing to do).

**Probe phase.** Companies from the profile's `data/companies_seen.json` (written each run by `/extract` — every company whose card survived the avoid-list drop, even ones later dropped by the title filter) that aren't already on the watchlist get probed against the keyless careers API (`<tenant>.keka.com/careers/api/organization/default/careerportalinfo`), guessing likely tenant subdomains from the company name. A confirmed hit is auto-added under `## Auto-discovered`; a miss is recorded so it's never re-probed. Curated entries under `## Curated` (hand-added) are never touched by the probe.

**Fetch phase.** For every board on the watchlist (curated + auto-discovered), resolve its portal guid, then pull open positions. Skips job ids already in `kekaSeen` or the profile's cache, then applies the same avoid-list and title gates as the LinkedIn lane. Caps new jobs per run at `KEKA_MAX_NEW` (default 40) so one large board can't crowd out everything else.

**Merge.** Surviving jobs are appended to `jobs_raw_text.json` in the standard extract record shape, with `kk-<id>` job ids — downstream stages (`compress` → `/structure` → …) don't need to know which channel a job came from.

**Fail-soft.** A single board failing to fetch is skipped and logged, not fatal. If every board fails (API outage), the run logs a warning and still exits 0 — this lane must never hard-abort `/run`. Exits non-zero only on a real parse/contract error (e.g. a malformed `keka_boards.md` line), which `/doctor` also catches ahead of time.

Watchlist format (`profiles/<name>/keka_boards.md`):

```
## Curated
- Acme Corp - acme

## Auto-discovered
- Widget Co - widgetco
```

Blank lines and `#` comments are ignored.

**Recovery.** Emitted job ids are recorded in `data/keka_seen.json` immediately, so a run that crashes *after* `/keka` but *before* `/sync` strands that batch (same class of loss as a crashed LinkedIn run's search window). To recover, delete the profile's `data/keka_seen.json` and re-run — already-synced jobs are still skipped via the cache, and the rest get re-evaluated.
