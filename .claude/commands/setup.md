---
description: Onboarding wizard — one command from a fresh clone to a running profile. Idempotent, resumable at any step.
---

`$ARGUMENTS` = profile name (lowercase letters, digits, hyphens — e.g. `harish`). Walk through every step below in order, in this one invocation — don't stop after the Notion wiring and leave the rest as homework. Re-running later is always safe: every step is check-before-act and skips what's already done. `jobbunny setup --profile <p>` (`src/cli/commands/setup.ts`) covers only the non-interactive spine (scaffold + status checks) — the Notion adopt-or-create and secrets prompt below are done by you (Claude), not by that command.

**0. Prerequisites — collect these before running anything.** Two one-time manual Notion steps:
  - **Integration token.** notion.so/my-integrations → New integration → copy the "Internal Integration Token". Pasted into a masked prompt in step 2 — never typed in chat.
  - **Shared root page.** In Notion, create a page titled exactly `Job Bunny's List` (byte-exact) and share it with the integration (··· menu → Connections → add the integration).
  Confirm the user has both ready before moving on. (If they already have another Job Bunny profile, these likely already exist — ask first.)

**1. Dependencies.**
```bash
source ~/.nvm/nvm.sh && nvm use 24
```
Node ≥ 24 is required (v2 runs TypeScript natively, no build step). If `node_modules/` is missing (fresh clone), run `npm install` first.

**2. Scaffold + status check.**
```bash
node src/cli/main.ts setup --profile <profile>
```
Idempotent: creates `profiles/<profile>/` and seeds any missing `profile.json` / `filter.json` / `search_urls.md` / `avoid.md` (never clobbers an existing file), then reports `done` / `skipped` / `needs-action` per step (`.env` NOTION_TOKEN, `resume.json`, `search_urls.md`, page-inventory coverage). Exit code is 0 iff every step is done-or-skipped. Surface its output verbatim — this is what tells you what's still needed below.

**3. Notion token.** If step 2 reported `.env NOTION_TOKEN: needs-action`, ask for the token from step 0 (masked) and append `NOTION_TOKEN=<token>` to `.env` yourself (create `.env` from `.env.example` if it doesn't exist yet).

**4. Notion DB — adopt or create.** Using Notion MCP tools, find or create the profile's own page (a child of "Job Bunny's List") with a "Job Bunny — Jobs" database inside it. If "Could not find a page titled..." — the step-0 page isn't actually shared with the integration yet; point the user back there. Once you have the database id, write it into `profiles/<profile>/profile.json`: `settings.notion.dbId`, `connector: "notion"`, and `lanes` (start with `["linkedin"]`; add `"greenhouse"`/`"keka"` once boards are curated). `settings.notion.dryRun` defaults `true` — leave it there for a fresh profile.

**5. Résumé — parse it, don't hand it to the user as homework.** Ask for a resume: a file path (PDF or plain text) or pasted text. Read it directly (the Read tool handles PDFs) and extract these fields yourself into `profiles/<profile>/resume.json` (there is no template to overwrite — v2 doesn't seed this file, `setup` just checks it exists):
  - `current_yoe` (number), `target_seniority` (array, e.g. `["Staff","Lead"]`), `core_skills` / `secondary_skills` (arrays), `domain_experience` (array), `usp` (array, 1-2 short differentiator lines).
  - `preferred_work_type` and `location` are rarely reliable from a resume — ask for both together in one follow-up question. `location` accepts a string or array of strings.
  Show a compact summary and get one confirmation before proceeding. Hand-editing `resume.json` directly is still supported if the user prefers it. (This is the one-time PDF→JSON seed CLAUDE.md allows — `resume.json` is the only résumé source v2 reads; there is no `resume_meta.json` derivation step anymore.)

**6. Title filter — derive it, don't dump JSON on the user.** Edit `profiles/<profile>/filter.json`'s `title` block yourself (`FilterConfigSchema`, `src/core/filter/config.ts`): `title.domain` / `title.function` / `title.seniority`, each a `{ match: [...], reject: [...], severity: "hard"|"soft" }` rule, derived from the target roles/domain gathered in step 5. Show the resulting block and get one confirmation — a mismatch here doesn't error, it silently drops (hard) or penalizes (soft) every non-matching job.

**7. Geo filter — derive it, don't dump JSON on the user.** Edit `filter.json`'s `locations[]` yourself: one entry per home city with `city`, `country`, and `workTypes` (`["onsite","hybrid","remote"]` subset) — this is now the sole home-geo source (no more `resume_meta.json` location lookup). If the candidate takes remote roles in specific timezones, set `timezones.accept` (e.g. `["APAC","EMEA"]`) and `timezones.severity`. Show the resulting block and get one confirmation — a mismatch here silently drops or penalizes every job at that location.

**8. First search URL.** Ask for one LinkedIn saved-search URL and a short label, then run `node src/cli/main.ts lane add-url "<url>" "<label>" --profile <profile>`. More can be added later the same way. Confirm a `page_inventory/<page>.json` exists for its page-type (run `/page-analyse <page-slug>` if not).

**9. Notifications.** One yes/no: want a Telegram run digest? If yes, walk the README's "Telegram digest" section with the user yourself: `TELEGRAM_BOT_TOKEN` from @BotFather into `.env` (masked, same handling as step 3), get the numeric `chat_id`, then add `"telegram"` to `notifiers` and `settings.telegram.chatId` (a number, not a string) in `profile.json`. If no, skip.

**10. Verify.** Finish by running `node src/cli/main.ts doctor --profile <profile>` yourself and reporting its actual pass/fail output. A red Chrome/CDP check at this point is expected if they haven't logged into LinkedIn in `.chrome-debug/` yet; say so rather than treating it as a setup failure.

Report a short summary at the end: what's done, what's still red (if anything), and the one-line next action (usually `node src/cli/main.ts run --profile <profile>`).
