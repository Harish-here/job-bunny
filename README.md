<p align="center">
  <img src="assets/job-bunny-logo.svg" alt="Job Bunny" width="120" />
</p>

```text
█████  ███  ████      ████  █   █ █   █ █   █ █   █
   █  █   █ █   █     █   █ █   █ ██  █ ██  █ █   █
   █  █   █ █   █     █   █ █   █ ██  █ ██  █  █ █
   █  █   █ ████      ████  █   █ █ █ █ █ █ █   █
   █  █   █ █   █     █   █ █   █ █  ██ █  ██   █
█  █  █   █ █   █     █   █ █   █ █  ██ █  ██   █
 ██    ███  ████      ████   ███  █   █ █   █   █
```

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="version" />
</p>

A personal job-search companion that runs on your own Mac. Several times a day it scrapes your saved LinkedIn job searches, pulls fresh postings from company career APIs (Greenhouse, Keka), filters and ranks everything against your resume, and syncs the survivors to a Notion board — with an optional Telegram digest so you know what landed.

This is a clean-room TypeScript rewrite (v2, under `src/`) of the original plain-JavaScript pipeline (v0); v0 has been deleted from this branch and lives on `main` for history only. `src/` is the pipeline, full stop — see [CLAUDE.md](CLAUDE.md) for the full architecture detail.

Built to be driven by [Claude Code](https://claude.com/claude-code): a few workflow steps (onboarding, page-selector maintenance, the LLM structuring stage, session close-out) run as Claude Code slash commands; the rest is a single `jobbunny` CLI.

## How it works

```
LinkedIn (Playwright over Chrome CDP) ─┐
Greenhouse / Keka APIs ────────────────┼─► reconcile ─► farm ─► source ─► compress ─► structure (LLM)
                                        ┘                                                    │
                                                                                              ▼
        Notion board ◄─ sync ◄─ rank ◄─ dedup ◄──────────────────────────────── filter ◄─ assemble
                                                          │
                                              Telegram digest (optional)
```

Ten stages, one process, one `jobbunny run` invocation. Full stage-by-stage detail is in [CLAUDE.md](CLAUDE.md).

- **Config-driven scraping.** Selectors are config, not code. When LinkedIn changes its DOM, regenerate the page inventory with `/page-analyse` — no code changes needed.
- **Fail-soft, but loud on total outage.** A broken search page, a dead careers API, or one bad job card is skipped and logged; the run keeps going. But if a whole lane comes back completely empty (e.g. an expired LinkedIn login), that's treated as a real failure, not silence.
- **Notion is the source of truth.** The local cache is rebuilt from your Notion database on every run, and sync only ever touches automated fields — your notes and statuses are safe.
- **Multi-profile.** Each person gets a `profiles/<name>/` directory with their own resume, search URLs, filters, Notion database, and schedule. One machine can run several profiles back to back.

## Requirements

- macOS (scheduling uses launchd; Chrome is expected at its standard path)
- **Node.js ≥ 24** — v2 runs TypeScript natively with zero build step; older Node fails immediately. If you use nvm: `source ~/.nvm/nvm.sh && nvm use 24` before any `jobbunny`/`npm` command.
- Google Chrome with a logged-in LinkedIn session (kept in a dedicated `.chrome-debug/` browser profile) — driven via CDP, not `playwright install`
- [Claude Code](https://claude.com/claude-code) CLI
- A [Notion internal integration](https://www.notion.so/my-integrations) token
- Optional: a Telegram bot (via @BotFather) for run digests

## Getting started

From a fresh clone, in Claude Code:

```
/setup <your-name>
```

The interactive wizard walks you through onboarding (Notion adopt-or-create, secrets, resume import, search URLs). It calls `jobbunny setup --profile <name>` internally for the non-interactive scaffolding steps and is idempotent — rerun any time to resume where you left off.

Then:

```bash
source ~/.nvm/nvm.sh && nvm use 24
node src/cli/main.ts doctor --profile <name>   # preflight: secrets, Chrome/CDP, page inventories, cache
node src/cli/main.ts run --profile <name>      # full pipeline, end to end
```

(Once installed as a bin, drop the `node src/cli/main.ts` prefix and just run `jobbunny doctor` / `jobbunny run`.)

Useful day-2 commands:

| Command | What it does |
|---|---|
| `jobbunny lane add-url <url> [label] --profile <name>` | Add a LinkedIn saved-search URL |
| `/page-analyse` | Rebuild a page inventory from live DOM analysis |
| `jobbunny schedule install` | Install launchd jobs from every profile's `schedule` in `profile.json` |
| `jobbunny reconcile --profile <name>` | Rebuild the local cache from your Notion database |
| `jobbunny routine cleanup --profile <name>` | Archive stale Notion entries (dry-run by default) |
| `jobbunny profile build --profile <name>` | Regenerate filter/rank config from an edited `resume.json` |

## Telegram digest (optional)

There's no setup wizard for this — wire it by hand:

1. **Bot token (one-time, shared across profiles).** Message `@BotFather` on Telegram, run `/newbot`, and add the token it gives you to `.env` as `TELEGRAM_BOT_TOKEN` (never in chat).
2. **Your chat id.** Message `@userinfobot` — it replies with your numeric id immediately.
3. **Wire it into the profile.** In `profiles/<name>/profile.json`: add `"telegram"` to the top-level `notifiers` array, and under `settings` add `"telegram": { "chatId": <number> }` (a number, not a quoted string) — leave every other key untouched.
4. **Verify.** `jobbunny doctor --profile <name>` checks `TELEGRAM_BOT_TOKEN` against Telegram's `getMe` endpoint (it can't validate `chatId` itself — a live digest at the next run is the real test).

## Scheduled runs

Set times in your profile's `profile.json`:

```json
"schedule": { "times": ["09:00", "14:00", "19:00"] }
```

then run `jobbunny schedule install`. Each firing runs `jobbunny run --profile <name> --headless` with watchdogs for per-stage timeouts and stalls; profiles sharing a time slot are chained into one job and run strictly sequentially (they share one Chrome/CDP session). A Telegram digest is sent at the end of every run, success or failure. Mid-day reruns pick up newly posted jobs instead of redoing the day's work — farming resumes per URL (`--resume`). Per-profile run logs land in `profiles/<name>/data/runs/<date>/`; the launchd job's own stdout/stderr land in `~/Library/Logs/JobBunny/`.

If your Mac regularly sleeps through a scheduled time, pre-wake it: `sudo pmset repeat wakeorpoweron MTWRF <HH:MM:SS>` a few minutes early (requires you to already be logged in — screen-locked is fine, logged out is not — and is most reliable on AC power with the lid closed).

## Development

```bash
source ~/.nvm/nvm.sh && nvm use 24
npm run check                                # the gate: typecheck + lint + boundaries + tests
node --test src/core/filter/engine.test.ts   # one file
```

- `profiles/rajni/` is a committed synthetic fixture profile for runtime verification — use it instead of real profiles when testing stages, never `profiles/harish/` (real user data).
- Architecture, internals, and per-stage detail live in [CLAUDE.md](CLAUDE.md) and `.claude/agents/explainer.md`.
- Release history: [CHANGELOG.md](CHANGELOG.md).

Private project — not published to npm.
