# Consumer CLI & data home — design spec

**Date:** 2026-08-07
**Status:** Approved (brainstormed with user; §7 revised per user to a removable one-shot command)
**Feeds:** /sdd-task-loop (briefs to be derived from this spec)

## 1. Problem & consumer story

Today `jobbunny` exists only as `node src/cli/main.ts …` run from the repo
root: the `bin` entry in `package.json` was never linked, and every path the
CLI touches (`profiles/`, per-profile SQLite DBs, `.env`, daemon pidfile,
Chrome login profile) resolves from `process.cwd()` or — worse for user data —
from `import.meta.url` inside the checkout.

Target consumer story:

1. Clone the repo, run `npm install -g .` (Node ≥ 24 — no build step, native
   type-stripping runs the `.ts` bin directly; shebang already present).
2. Run `jobbunny setup` **from anywhere**. All user data lives in
   `~/.jobbunny/`; the clone is just the program.
3. Publishing to npm later changes only the install step — nothing in this
   design may assume a repo checkout at runtime.

## 2. Decisions (closed — do not reopen in briefs)

| Decision | Choice |
|---|---|
| Distribution now | Clone + `npm install -g .`; npm registry publish is later and out of scope |
| Data home | `~/.jobbunny` on all OSes, overridable via `JOBBUNNY_HOME` env var |
| Migration | One-shot `jobbunny migrate-home` command, designed for later removal |
| `root` param name | **Kept** (it is the injection seam every test uses); doc comments updated to say "data home" |
| `release` command | Deliberate exception — stays `process.cwd()`-based (maintainer command, operates on the git checkout) |
| Platform-native dirs (XDG / Application Support / AppData) | Rejected — one path everywhere |
| Auto-detect repo-local data fallback | Rejected — exactly one data location; `migrate-home` is the bridge |

## 3. Data-home resolution

- New cli-layer helper (placement/naming per executor conventions, suggested
  `src/cli/home/`): `resolveHome(env?, homedir?)` →
  - `JOBBUNNY_HOME` if set (resolved to an absolute path against cwd if
    relative), else `join(os.homedir(), '.jobbunny')`.
  - `JOBBUNNY_HOME` must come from the real shell environment, **never** from
    `.env` — the `.env` location itself depends on the resolved home.
  - Injectable `env`/`homedir` for tests; no I/O in the resolver itself.
- Every `overrides.root ?? process.cwd()` default becomes
  `overrides.root ?? resolveHome()`. Known call sites (verify by grep, not
  from this list alone):
  - `src/cli/main.ts` (daemon pidfile read, line ~91)
  - `src/cli/wire/daemon.ts` (×2), `wire/migrate.ts`, `wire/compose.ts` (×2),
    `wire/board.ts`, `wire/builders.ts`
  - `src/cli/commands/lane_add_url.ts`, `commands/autostart.ts`,
    `commands/profile.ts` (×2), `commands/serve/index.ts`,
    `commands/config.ts`, `commands/run.ts`
  - **Excluded:** `commands/release/index.ts` (stays cwd — see §2) and all
    `*.test.ts` (they inject `root` explicitly; untouched).
- `.env` loading: `src/cli/main.ts` currently does side-effect
  `import 'dotenv/config'` (cwd-relative). Replace with an explicit
  `dotenv.config({ path: join(resolveHome(), '.env') })` executed before any
  command dispatch. Still exactly one load, still only in `main.ts`
  (CLAUDE.md: don't duplicate the load).

## 4. What lives where

**Home (`~/.jobbunny/`)** — user data only:

- `profiles/<name>/` — internal layout unchanged from today's
  `profiles/<name>/` in the repo. Consequence: **a repo checkout is itself a
  valid home**, which is how the committed `profiles/rajni/` fixture keeps
  working (§6).
- `.env` (`NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`).
- Daemon pidfile/state (wherever it lives under `root` today — it moves with
  `root`, no separate handling).
- `chrome/` — the persistent Chrome user-data-dir, **relocated** from the
  checkout-anchored `.chrome-debug/`. In
  `src/adapters/browser/cdp-chrome/launcher.ts` the default is currently
  `new URL('../../../../.chrome-debug', import.meta.url)`; the dir (and the
  kill-marker file inside it) becomes `join(home, 'chrome')`, injected at wire
  time. After this change **no user data is anchored via `import.meta.url`
  anywhere** (grep-verifiable). Adapters must not import cli, so the path is
  passed in by `cli/wire` — the launcher keeps an injectable param; whether a
  hardcoded default remains is the executor's call, but wire always passes it.

**Package (resolved via `import.meta.url` — existing pattern, unchanged)**:

- `ui/dist` (already resolved from `commands/board.ts`'s own location).
- LinkedIn `page_inventory/*.json`.
- All code.

## 5. Entry & guardrails

- `npm install -g .` links the existing `bin` (`jobbunny` → `src/cli/main.ts`).
  No packaging changes expected; verify the shebang path survives global
  install on this machine (nvm-managed Node 24).
- **Node version guard** at the top of the bin entry in `main.ts`: if
  `process.versions.node` major < 24, print one line
  (`jobbunny needs Node >= 24 (found <version>)`) and exit non-zero — before
  any import that would die on stripped types. Note: guard placement must
  account for ESM import hoisting (e.g. keep the guard ahead of type-bearing
  imports via module design, or accept that the guard lives in the first
  executed statement of an import-light entry — executor's call, but the
  failure a consumer sees must be the one-liner, not a SyntaxError).
- **Missing home**: `setup` and `migrate-home` create/populate it; every other
  command that needs the home reports
  `no jobbunny home at <path> — run 'jobbunny setup'` (exit non-zero, no
  ENOENT stack traces). `doctor` reports the resolved home path.

## 6. Daemon & autostart anchoring

- launchd plist (darwin autostart): program path = symlink-resolved absolute
  path to `main.ts` (derived from `import.meta`/`realpathSync`, captured at
  `autostart enable` time as today); `WorkingDirectory` = the resolved home
  (it is no longer the data anchor — data resolution goes through
  `resolveHome()` — but home is the least-surprising cwd for the daemon).
- `serve start|stop|status` become location-independent like everything else
  (pidfile under home).
- The live daemon on the primary machine keeps running until the migration
  step; nothing in this change restarts or re-anchors it implicitly.

## 7. `migrate-home` — one-shot, removable

One command bridges existing repo-local installs; it is expected to be deleted
once migration-era machines are done (keep it self-contained so removal is
one commit).

- **Invocation:** `jobbunny migrate-home [--from <path>] [--apply]`.
  Cross-profile by design (no `--profile`), like `serve`/`release`.
- **Source:** `--from` if given, else `process.cwd()` (run it from the old
  checkout). Source must look like a legacy install (has `profiles/`);
  otherwise report and exit non-zero.
- **Dry-run by default** (repo convention, same as `migrate` and
  `profile remove`): prints exactly what would move where; `--apply` executes.
- **Moves** into the resolved home:
  - `profiles/<name>/` for every profile **except `rajni`** (committed
    fixture stays in the repo),
  - `.env`,
  - `.chrome-debug/` → `chrome/`.
- **Safety rails:**
  - Refuses to run while the daemon is running (points at
    `jobbunny serve stop`) — it does not stop the daemon itself. The check
    reads the **source's** pidfile (a legacy install's daemon is anchored to
    the old checkout, not the new home), using the same pidfile/heartbeat
    helpers `serve status` uses.
  - Never clobbers: if a destination path already exists, refuse with a clear
    message (no merge logic — this is a one-time bridge, not a sync tool).
  - Does not touch autostart; on success prints next steps
    (`jobbunny autostart enable`, `jobbunny doctor --profile <name>`).
  - Never touches Notion or the network.

## 8. Dev & test workflow

- Unit tests inject `root` already — untouched; `npm run check` must stay
  green with no test rewrites beyond new code's own tests.
- Runtime verification:
  `JOBBUNNY_HOME=$PWD jobbunny <cmd> --profile rajni` from the checkout — the
  repo-as-home property (§4) keeps the rajni fixture flow working. The
  `verify` skill is updated to lead with this invocation.
- Never run experimental stages against the real `harish` profile (standing
  rule, unchanged).

## 9. Docs sweep

- **README**: rewritten install-first for consumers (clone → `npm install -g .`
  → `jobbunny setup`); `migrate-home` documented in a clearly-marked
  "existing installs" section.
- `.claude/agents/*`, `.claude/commands/*`, `.claude/skills/verify/SKILL.md`:
  `node src/cli/main.ts …` → `jobbunny …`; verify skill also gains the
  `JOBBUNNY_HOME=$PWD` framing.
- **CLAUDE.md**: needs the same command updates plus the home model — but
  CLAUDE.md edits require showing the user the exact text and getting explicit
  approval first (standing rule). The sdd brief for this task must route
  through the advisor/user, not edit directly.
- **Historical docs untouched:** `docs/superpowers/plans/`,
  `docs/superpowers/specs/` (earlier specs), `.superpowers/sdd/`,
  `docs/reviews/`.
- Per repo convention, explainer KB / executor agent docs are updated in the
  same change that alters behavior.

## 10. Error handling, blast radius, testing

- **Blast radius:** cli layer (home resolver, call-site defaults, dotenv,
  guards, new command) + one adapter default (`cdp-chrome` launcher dir,
  injected from wire) + autostart plist fields. No `core/`, `ports/`,
  `pipeline/`, `routines/` changes. Fail-soft/fail-loud semantics unchanged —
  this moves path anchors, not pipeline behavior. Boundary rules unaffected
  (helper lives in `cli`; adapters still import nothing outward).
- **New unit tests:** `resolveHome()` (env override, relative
  `JOBBUNNY_HOME`, default), Node-guard message shape, missing-home message,
  `migrate-home` planning/refusal logic (dry-run output, non-legacy source,
  daemon-running refusal, destination-exists refusal, rajni exclusion) with
  injected fs/paths per existing test conventions.
- **Acceptance criteria (all must hold):**
  1. `npm run check` green (3-OS CI matrix unaffected).
  2. After `npm install -g .`: `jobbunny --help` works from `$HOME`;
     `jobbunny doctor --profile x` from `$HOME` with no home dir prints the
     friendly missing-home line.
  3. `JOBBUNNY_HOME=<repo> jobbunny stage <stage> --profile rajni` passes per
     the verify skill.
  4. `migrate-home` dry-run from a scratch legacy-shaped dir prints the
     correct plan; `--apply` moves the files; second run refuses (nothing to
     move / destination exists).
  5. Grep proves no runtime `process.cwd()` data-anchoring outside `release`,
     and no `import.meta.url` anchoring of user data.

## 11. Out of scope

- npm registry publishing (later, once stable).
- Platform-native data dirs; Windows/Linux autostart.
- Renaming the `root` injection param.
- Any pipeline-stage behavior change.
- Automated migration of the primary machine (the command is built here, but
  running it there is a separate, user-driven step — stop daemon → migrate →
  re-enable autostart → doctor).
