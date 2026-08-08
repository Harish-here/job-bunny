<p align="center">
  <img src="assets/job-bunny-logo.svg" alt="Job Bunny" width="120" />
</p>

<p align="center">
  <img src="assets/job-bunny-wordmark.svg" alt="JOB BUNNY" width="340" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-3.0.0-blue" alt="version" />
</p>

## What it is

Job Bunny is a personal job-search pipeline that runs on your own machine. It scrapes your saved LinkedIn job searches (over CDP, using your own logged-in Chrome — no headless bot login), pulls fresh postings straight from company career APIs (Greenhouse, Keka), then filters and ranks everything against your profile. Results land in a local-first SQLite job board you browse and triage in the same browser tab you used to set it up, with an optional one-way Notion mirror and Telegram digests for anyone who wants them.

## Get started

```bash
git clone <repo> && cd job-bunny
npm install -g .        # Node ≥ 24, no build step — installs the jobbunny command (a packed copy)
jobbunny board
```

`board` starts the local server and prints a URL. Open it — with no profiles yet, you land straight on a six-step onboarding wizard, no config files to hand-edit:

1. **Name it** — pick a profile name.
2. **Pick a persona** — a preset pre-fills starter skills and title-matching rules you can edit later.
3. **About you** — answer a few questions; your title and location filter rules are derived live as you go.
4. **Where to hunt** — add your LinkedIn saved-search URLs.
5. **Extras** *(optional, skippable in one click)* — wire up a Notion mirror and/or a Telegram digest, tokens included; both write straight into the data home, no `.env` editing.
6. **Launch** — pick a schedule preset (or manual), then **Run now** if you want results immediately.

For scheduled runs after that: `jobbunny serve start` starts the in-process daemon that fires runs at your configured times; on macOS, `jobbunny autostart enable` registers it to start at login too.

**Requirements:** Node.js ≥ 24 (pinned by `.nvmrc`); Google Chrome with a logged-in LinkedIn session (kept in a dedicated `~/.jobbunny/chrome/` profile, driven via CDP — not `playwright install`); the [Claude Code](https://claude.com/claude-code) CLI on `PATH`, used by the pipeline's structuring stage (`jobbunny doctor` checks for it). Notion and Telegram are both optional and configured through the wizard, not required to install.

## The board

`jobbunny board` (profile-less, binds `127.0.0.1` only) serves the whole app:

- **Triage** — a keyboard-first queue for deciding on new matches.
- **Tracker** — a kanban board of everything you've moved past triage.
- **Runs** — run history with a live in-flight progress header while a run is going.
- **Analytics** — run stats and match-quality trends (arriving soon — currently a placeholder).
- **Setup & Health** — a hub of live `doctor` findings and integration checks, with guided fixes for anything red.
- **Settings** — forms for every config doc, plus an Edit-as-JSON escape hatch for anything the forms don't cover yet.
- **Sidebar Run now** — fires a run from anywhere in the app, with honest running/queued/error states and the Job Bunny mascot reacting to what's going on.

## Where your data lives

Everything the tool writes — your data, not the program — lives in `~/.jobbunny/`. Override the location with the `JOBBUNNY_HOME` environment variable (a real shell variable, e.g. exported in your shell profile — it is never read from `.env`). The data home holds:

- `profiles/<name>/` — per-profile config and the profile's own SQLite database
- `.env` — secrets (`NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`)
- the daemon pidfile and logs
- `chrome/` — the persistent Chrome profile holding your LinkedIn login

The clone is only the program; nothing user-specific is ever written into it. For local development, a checkout's own layout doubles as a valid data home (see Development below). Two error messages you may see, verbatim:

```
no jobbunny home at <path> — run 'jobbunny setup'
jobbunny needs Node >= 24 (found <version>)
```

### Existing installs

**One-time bridge — skip this if you're installing fresh.** If you have an older machine with a repo-local install (data living inside the checkout instead of `~/.jobbunny/`), move it with `jobbunny migrate-home`. This command will be removed once migration-era machines are done.

```bash
jobbunny serve stop                    # migrate-home refuses while the daemon is running
cd /path/to/your/old/checkout
jobbunny migrate-home                  # dry-run: prints exactly what would move
jobbunny migrate-home --apply
jobbunny autostart enable              # re-anchor the login agent (macOS)
jobbunny doctor --profile <name>
```

It moves every `profiles/<name>/` except the committed `rajni` fixture, `.env`, and `.chrome-debug/` (renamed to `chrome/`). Two refusals to know about: it will not run while the daemon is alive, and it refuses rather than overwriting anything that already exists at the destination.

## CLI reference

`jobbunny <command> [options]` — the wizard covers day-1 setup, but every knob is also reachable from the CLI:

| Command | What it does |
|---|---|
| `run --profile <name> [--resume] [--headless] [--dry-run] [--run-cap-ms <ms>]` | Full pipeline, end to end |
| `doctor --profile <name>` | Preflight: secrets, Chrome/CDP, page inventories, cache, data home |
| `stage <stage-name> --profile <name>` | Run a single pipeline stage |
| `routine <routine-name> --profile <name>` | Run a named routine (e.g. `cleanup`) |
| `migrate --profile <name> [--apply]` | One-time Notion → local sqlite import (dry-run by default) |
| `migrate-home [--from <path>] [--apply]` | One-shot move of a legacy repo-local install into the data home (dry-run by default) |
| `board [--port <n>]` | The job-board UI + API, all profiles, `127.0.0.1` only (default port 1994) |
| `runs --profile <name>` / `runs show <id> --profile <name>` | Run history from the DB |
| `serve start\|stop\|status` | Start/stop/check the in-process scheduling daemon (cross-profile) |
| `autostart enable\|disable` | Register/remove a login LaunchAgent for `serve start` (darwin only) |
| `config get\|set <doc> --profile <name>` / `config export\|import --profile <name> [--dir <d>]` | Read/write a config doc, or export/import the whole set |
| `lane add-url <url> [label] --profile <name>` | Add a LinkedIn saved-search URL |
| `profile build --profile <name>` / `profile remove --profile <name> [--force]` | Regenerate filter/rank config from `resume.json`, or delete a profile |
| `setup --profile <name>` | Non-interactive onboarding steps (scaffold, resume/search-url/page-inventory checks) — the board's wizard is the recommended path for a new profile |

Run `jobbunny --help` for the exact usage string. Releases are `npm run release -- <X.Y.Z>` — maintainer-only, cross-profile.

## Development

```bash
npm run check                                # the gate: typecheck + lint + boundaries + tests
node --test src/core/filter/engine.test.ts   # one file

npm run ui:check                             # ui/'s own gate (biome + tsc + vitest)
npm run ui:build                             # build the board SPA into ui/dist
npm run ui:e2e                               # Playwright e2e smoke against the built UI

# Verify a stage against the committed synthetic fixture profile, using the
# checkout itself as the data home. Run through the checkout's own entry
# point (node src/cli/main.ts), not the globally installed `jobbunny` —
# `npm install -g .` installs a packed COPY, not a symlink, so the global
# binary does not pick up local changes; re-run it after pulling.
JOBBUNNY_HOME=$PWD node src/cli/main.ts stage source --profile rajni
JOBBUNNY_HOME=$PWD node src/cli/main.ts doctor --profile rajni
```

- `profiles/rajni/` is a committed synthetic fixture profile for runtime verification — use it instead of real profiles when testing stages, never `profiles/harish/` (real user data).
- Architecture, internals, and per-stage detail live in [CLAUDE.md](CLAUDE.md) and `.claude/agents/explainer.md`.
- Release history: [CHANGELOG.md](CHANGELOG.md).

## Honest caveats

- **Globally-installed copies don't ship the built board UI yet.** `ui/dist` is gitignored and not built as part of a plain `npm install -g .`. Run `jobbunny board` from a checkout instead (after `npm run ui:build`) until packaging ships the built UI.
- **LinkedIn scraping needs your own logged-in Chrome** and paces itself deliberately (jittered navigation delays, a pause between saved searches, and a circuit breaker on repeated soft-blocks) — it is not built for speed, it's built to not get your account flagged.

Private project — not published to npm.
