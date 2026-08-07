<p align="center">
  <img src="assets/job-bunny-logo.svg" alt="Job Bunny" width="120" />
</p>

<p align="center">
  <img src="assets/job-bunny-wordmark.svg" alt="JOB BUNNY" width="340" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.2.0-blue" alt="version" />
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

- macOS, Windows, or Linux — scheduling is a cross-platform in-process daemon, not an OS-level scheduler, and Chrome discovery resolves per-OS candidate paths automatically; see "Scheduled runs" below for autostart-at-login support per OS.
- **Node.js ≥ 24** (pinned by `.nvmrc`; `nvm install 24 && nvm alias default 24` on a fresh machine) — v2 runs TypeScript natively with zero build step; older Node fails immediately.
- Google Chrome with a logged-in LinkedIn session (kept in a dedicated `.chrome-debug/` browser profile) — driven via CDP, not `playwright install`
- [Claude Code](https://claude.com/claude-code) CLI — the `claude` binary must resolve on `PATH`; `jobbunny doctor` checks this directly. Claude Code itself is cross-platform, so this is a prerequisite to install, not an OS blocker.
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
node src/cli/main.ts doctor --profile <name>   # preflight: secrets, Chrome/CDP, page inventories, cache
node src/cli/main.ts run --profile <name>      # full pipeline, end to end
```

(Once installed as a bin, drop the `node src/cli/main.ts` prefix and just run `jobbunny doctor` / `jobbunny run`.)

Useful day-2 commands:

| Command | What it does |
|---|---|
| `jobbunny lane add-url <url> [label] --profile <name>` | Add a LinkedIn saved-search URL |
| `/page-analyse` | Rebuild a page inventory from live DOM analysis |
| `jobbunny serve start\|stop\|status` | Start/stop/check the in-process scheduling daemon (cross-profile) |
| `jobbunny autostart enable\|disable` | Register/remove a login LaunchAgent that runs `serve start` at login (darwin only) |
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

then start the daemon once: `jobbunny serve start`. It ticks a wall clock every 30 seconds and reasons about "is a run owed right now" against local time — so a reboot or a sleeping laptop produces a *late* run within `schedule.graceMinutes` (default 90) of the missed slot, never a silently skipped one (and, since the daemon checks each profile's own database for already-served slots rather than the filesystem, a daemon restart within that window never fires a duplicate run either). Each firing runs `jobbunny run --profile <name> --headless` with the same per-stage timeout/stall watchdogs as any other invocation, plus an external SIGTERM/SIGKILL backstop; profiles sharing a time slot run strictly sequentially (they share one Chrome/CDP session). A Telegram digest is sent at the end of every run, success or failure. Mid-day reruns pick up newly posted jobs instead of redoing the day's work — the LinkedIn lane skips job ids already present in the Notion-backed cache. Per-profile run/checkpoint history lives in that profile's own `profiles/<name>/data/jobbunny.db` (a `runs`/`checkpoints` row per invocation and per-stage snapshot, local start time), browsable via `jobbunny runs`; the daemon's own log and every spawned run's captured stdout/stderr land in `~/.jobbunny/logs/`.

- `jobbunny serve status` reports whether the daemon is running, its uptime, whether it appears wedged, and the next scheduled slot.
- `jobbunny serve stop` shuts it down cleanly.
- **macOS**: `jobbunny autostart enable` registers a login LaunchAgent that runs `jobbunny serve start` at login — the LaunchAgent carries no schedule knowledge itself; the daemon's own tick loop decides when a run actually fires. `jobbunny autostart disable` removes it.
- **Windows / Linux**: autostart-at-login isn't automated yet — run `jobbunny serve start` once after each login/boot, or register the OS-native "run at login" mechanism by hand (Task Scheduler on Windows, a systemd `--user` unit on Linux) pointing at `jobbunny serve start` with no arguments.

Every `jobbunny` command warns to stderr when the daemon pidfile shows no live daemon, so a down daemon is loud the next time you run anything, on any platform.

If your Mac regularly sleeps through a scheduled time, pre-wake it: `sudo pmset repeat wakeorpoweron MTWRF <HH:MM:SS>` a few minutes early (requires you to already be logged in — screen-locked is fine, logged out is not — and is most reliable on AC power with the lid closed).

## Development

```bash
npm run check                                # the gate: typecheck + lint + boundaries + tests
node --test src/core/filter/engine.test.ts   # one file
```

- `profiles/rajni/` is a committed synthetic fixture profile for runtime verification — use it instead of real profiles when testing stages, never `profiles/harish/` (real user data).
- Architecture, internals, and per-stage detail live in [CLAUDE.md](CLAUDE.md) and `.claude/agents/explainer.md`.
- Release history: [CHANGELOG.md](CHANGELOG.md).

Private project — not published to npm.
