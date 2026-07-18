---
description: Onboarding wizard — one command from a fresh clone to a running profile. Idempotent, resumable at any step.
---

`$ARGUMENTS` = profile name (lowercase letters, digits, hyphens — e.g. `harish`). Walk through every step below in order, in this one invocation — don't stop after the Notion wiring and leave the rest as homework. Re-running later is always safe: every step is check-before-act and skips what's already done.

**0. Prerequisites — collect these before running anything.** Two one-time manual Notion steps init.js can't do for the user:
  - **Integration token.** notion.so/my-integrations → New integration → copy the "Internal Integration Token". Pasted into a masked prompt in step 2 — never typed in chat.
  - **Shared root page.** In Notion, create a page titled exactly `Job Bunny's List` (byte-exact — the schema/init code looks it up by this title) and share it with the integration (··· menu → Connections → add the integration).
  Confirm the user has both ready — a token to paste, a page created and shared — before moving on. (If they already have another Job Bunny profile, these likely already exist — ask first.)

**1. Dependencies.** If `node_modules/` is missing (fresh clone), run `npm install` before anything else — nothing downstream works without it. `node scripts/setup/init.js` also re-checks this: Node version and installed packages are hard gates (it aborts with a clear fix if either is missing); Chrome presence and whether the repo sits under a macOS-protected folder like `~/Desktop`/`~/Documents`/`~/Downloads` (which silently breaks `/schedule` later) are soft warnings that let setup continue, since `/doctor` is the authoritative Chrome/CDP gate. Surface whichever message it prints verbatim rather than guessing at a workaround.

**2. Core setup:**

```bash
node scripts/setup/init.js <profile>
```

This ensures `.gitignore` ignores `.env`/`profiles/`/`config.json` first, prompts (masked) for the shared Notion token from step 0, scaffolds `profiles/<profile>/` (avoid.md, search_urls.md, filter_config.json, resume.json — all seeded from `templates/`/`resume.example.json`, none clobbered if already filled), writes `config.json` if missing, then locates-or-creates the profile's own Notion page (a child of "Job Bunny's List") with a "Job Bunny — Jobs" DB inside it, persisting both IDs to `profiles/<profile>/profile.json`. If it fails at "Could not find a page titled..." the step-0 page isn't actually shared with the integration yet — point the user back there rather than retrying blindly.

**3. Résumé — parse it, don't hand it to the user as homework.** Ask for a resume: a file path (PDF or plain text) or pasted text. Read it directly (the Read tool handles PDFs) and extract these fields yourself into `profiles/<profile>/resume.json`, overwriting the seeded template:
  - `current_yoe` (number), `target_seniority` (array, e.g. `["Staff","Lead"]`), `core_skills` / `secondary_skills` (arrays — split what the resume emphasizes vs. mentions in passing), `domain_experience` (array), `usp` (array, 1-2 short differentiator lines).
  - `preferred_work_type` and `location` are rarely reliable from a resume — ask for both together in a single follow-up question instead of guessing. `location` accepts a string or an array of strings (e.g. `["Bangalore","Chennai"]`) if the candidate is open to more than one home city.
  - If `target_seniority` is ambiguous from the resume's titles/YoE, ask for it in that same follow-up round instead of guessing silently.
  Show a compact summary of all 8 fields and get one confirmation before proceeding — don't ask field-by-field. Hand-editing `profiles/<profile>/resume.json` directly is still supported if the user prefers it: tell them the path, wait for confirmation, then continue. (This is the one-time PDF→JSON seed CLAUDE.md allows — the daily `/run` pipeline never parses PDFs, only `resume_meta.json`.)

**4. Derive résumé metadata**, once step 3 is confirmed:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/setup/generate_meta.js
```

This validates every field's shape, not just presence — a failure names the exact field and expected shape; fix `resume.json` and re-run rather than guessing at a workaround.

**5. Title filter — derive it, don't dump JSON on the user.** From the target roles/domain already gathered in step 3, edit `profiles/<profile>/filter_config.json`'s `title_filter` block yourself: set `domain` to keywords matching their actual field (the seeded default is a frontend/UI persona — `frontend`/`react`/`design systems` — replace it if that's not them), and adjust `function.block` so it doesn't exclude their own function (e.g. drop "backend"/"data" from the block list for a backend/data candidate). Show the resulting block and get one confirmation — a mismatch here doesn't error, it silently drops every job with "no domain match", so this confirmation matters. If the file also has `seniority_keywords`, `title_keywords`, or `skills_overlap_threshold` keys (older profiles seeded before these were removed from the template), ignore them — only `title_filter` is read.

**6. Geo filter — derive it, don't dump JSON on the user.** Edit `profiles/<profile>/filter_config.json`'s `locations` / `home_country` / `remote` block yourself: infer `home_country` from the resume/location answer gathered in step 3 and confirm it with the user; build `locations[]` from those same home cities, one entry per city with its country and accepted work types (default `["On-site","Hybrid"]` unless they say otherwise); ask which neighbouring countries, if any, they'd take a REMOTE role from and put those in `remote.eligible_countries` (the home country is auto-included by the filter engine, so don't repeat it there); ask about their timezone tolerance and set `remote.timezones.acceptable`/`borderline` from the answer — describe this as "which timezones you can work / are borderline on," not a fixed list (`APAC`/`EMEA` is only an example for the seeded frontend/UI persona, not a universal default). Show the resulting block and get one confirmation — a city/country mismatch here doesn't error, it silently drops every job at that location, so this confirmation matters.

**7. First search URL.** Ask for one LinkedIn saved-search URL and a short label (hint: search LinkedIn Jobs with your filters applied, then copy the URL from the address bar), then invoke `/add-url <profile> <url> <label>` (or run `JOBBUNNY_PROFILE=<profile> node scripts/setup/add_url.js "<url>" "<label>"` directly). More can be added later the same way — this just gets the profile past "zero searches."

**8. Notifications.** One yes/no: want a Telegram run digest? If yes, run `/notify-setup <profile>`; if no, skip — `/doctor` treats this as optional and won't fail on it.

**9. Verify.** Finish by running `/doctor` yourself and reporting its actual pass/fail output — don't just tell the user to run it later. It also validates `resume_meta.json`'s `location` shape. A red Chrome/CDP check at this point is expected if they haven't logged into LinkedIn in `.chrome-debug/` yet; say so rather than treating it as a setup failure.

Report a short summary at the end: what's done, what's still red (if anything), and the one-line next action (usually `/run <profile>`).
