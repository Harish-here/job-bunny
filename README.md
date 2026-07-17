<p align="center">
  <img src="assets/job-bunny-logo.svg" alt="Job Bunny" width="120" />
</p>

# Job Bunny 🐇

A personal job-search companion that runs on your own Mac. Several times a day it scrapes your saved LinkedIn job searches, pulls fresh postings from company career APIs (Greenhouse, Keka), filters and ranks everything against your resume, and syncs the survivors to a Notion board — with an optional Telegram digest so you know what landed.

Built to be driven by [Claude Code](https://claude.com/claude-code): the pipeline's orchestration and one LLM stage (structuring raw job descriptions into clean fields) run as Claude Code slash commands; everything else is plain Node.

## How it works

```
LinkedIn (Playwright over Chrome CDP) ─┐
Greenhouse boards API ─────────────────┼─► raw job text ─► compress ─► structure (LLM)
Keka careers API ──────────────────────┘                                    │
                                                                            ▼
        Notion board ◄─ sync ◄─ rank ◄─ dedup ◄─ filter ◄─ assemble ◄─ structured jobs
                                                          │
                                              Telegram digest (optional)
```

- **Extraction is config-driven.** Selectors live in `page_inventory/*.md` files, read at runtime. When LinkedIn changes its DOM, you regenerate the inventory with `/page-analyse` — no code changes.
- **Fail-soft scraping.** A broken search page or a dead careers API skips that lane and keeps going; one stale selector never kills a run.
- **Notion is the source of truth.** The local cache is rebuilt from your Notion database on every run, and sync only ever touches automated fields — your notes and statuses are safe.
- **Multi-profile.** Each person gets a `profiles/<name>/` directory with their own resume, search URLs, filters, Notion database, and schedule. One machine can run several profiles back to back.

## Requirements

- macOS (scheduling uses launchd; Chrome is expected at its standard path)
- Node.js ≥ 20
- Google Chrome with a logged-in LinkedIn session (kept in a dedicated `.chrome-debug/` browser profile)
- [Claude Code](https://claude.com/claude-code) CLI
- A [Notion internal integration](https://www.notion.so/my-integrations) token
- Optional: a Telegram bot (via @BotFather) for run digests

## Getting started

From a fresh clone, in Claude Code:

```
/setup <your-name>
```

The wizard walks you through everything: dependencies, your `.env` (Notion token), resume import, Notion database creation, search URLs, and a first health check. It's idempotent — rerun it any time to resume where you left off.

Then:

```
/doctor        # preflight: secrets, Chrome/CDP, page inventories, cache
/run           # full pipeline, end to end
```

Useful day-2 commands:

| Command | What it does |
|---|---|
| `/add-url` | Add a LinkedIn saved-search URL (strips tracking params) |
| `/page-analyse` | Rebuild a page inventory from live DOM analysis |
| `/schedule` | Install launchd jobs from each profile's `schedule` in `profile.json` |
| `/notify-setup` | Wire up Telegram notifications for a profile |
| `/reconcile` | Rebuild the local cache from your Notion database |
| `/cleanup` | Archive stale Notion entries (dry-run by default) |
| `/update-resume` | Regenerate resume metadata after editing `resume.json` |

## Scheduled runs

Set times in your profile:

```json
"schedule": { "enabled": true, "times": ["09:00", "14:00", "19:00"] }
```

then run `/schedule`. Each firing launches a headless `claude -p "/run <profile>"` with watchdogs for hangs and stalls, keeps the machine awake with `caffeinate`, and sends a Telegram digest with the run summary. Mid-day reruns pick up newly posted jobs instead of redoing the day's work — extraction is resumable per URL.

## Development

```bash
npm test                                    # unit tests (node --test, no browser needed)
node --test scripts/pipeline/filter.test.js # one file
```

- Pipeline stages are plain Node CLIs: `JOBBUNNY_PROFILE=<name> node scripts/pipeline/<stage>.js`.
- `profiles/rajni/` is a committed synthetic fixture profile for runtime verification — use it instead of real profiles when testing stages.
- Architecture notes and contracts live in [CLAUDE.md](CLAUDE.md) and in each script's header comment.
- Release history: [CHANGELOG.md](CHANGELOG.md).

## Layout

```
.claude/commands/    slash commands (the workflow surface)
scripts/pipeline/    extract, ATS lanes, compress, assemble, filter, dedup, rank
scripts/notion/      cache reconcile, sync, cleanup
scripts/notify/      Telegram digests
scripts/ops/         doctor, scheduler, release, run watchdogs
scripts/lib/         config/paths, browser (CDP), shared utils
page_inventory/      runtime selector configs per page-type
profiles/<name>/     per-person config + per-run data/ intermediates
templates/           blank profile files used by /setup
```

Private project — not published to npm.
