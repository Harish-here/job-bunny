---
description: Onboarding wizard — one command from a fresh clone to a running profile. Idempotent, resumable at any step.
---

`$ARGUMENTS` = profile name (lowercase letters, digits, hyphens — e.g. `harish`). Walk through every step below in order, in this one invocation — don't stop after the Notion wiring and leave the rest as homework. Re-running later is always safe: every step is check-before-act and skips what's already done.

**1. Dependencies.** If `node_modules/` is missing (fresh clone), run `npm install` before anything else — nothing downstream works without it. `node scripts/setup/init.js` also re-checks this: Node version and installed packages are hard gates (it aborts with a clear fix if either is missing); Chrome presence and whether the repo sits under a macOS-protected folder like `~/Desktop`/`~/Documents`/`~/Downloads` (which silently breaks `/schedule` later) are soft warnings that let setup continue, since `/doctor` is the authoritative Chrome/CDP gate. Surface whichever message it prints verbatim rather than guessing at a workaround.

**2. Core setup:**

```bash
node scripts/setup/init.js <profile>
```

This ensures `.gitignore` ignores `.env`/`profiles/`/`config.json` first, prompts (masked) for the shared Notion token, scaffolds `profiles/<profile>/` (avoid.md, search_urls.md, filter_config.json, resume.json — all seeded from `templates/`/`resume.example.json`, none clobbered if already filled), writes `config.json` if missing, then locates-or-creates the profile's own Notion page (a child of "Job Bunny's List", which must already be shared with your integration) with a "Job Bunny — Jobs" DB inside it, persisting both IDs to `profiles/<profile>/profile.json`.

**3. Résumé.** `profiles/<profile>/resume.json` now exists (seeded from `resume.example.json` if it wasn't already there). Tell the user its path and pause here — ask them to fill in `current_yoe`, `target_seniority`, `core_skills`, `secondary_skills`, `preferred_work_type`, `location`, `domain_experience`, `usp`. Don't proceed to step 4 until they confirm it's done. (No PDF parsing — hand-edited JSON is the source of truth, per CLAUDE.md.)

**4. Derive résumé metadata**, once step 3 is confirmed:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/setup/generate_meta.js
```

**5. Title filter.** `profiles/<profile>/filter_config.json`'s `title_filter` block (`seniority`, `domain`, `function.allow`, `function.block` term lists) is what `filter.js`/`title_filter.js` use to gate which job titles survive — it was seeded from `templates/filter_config.json`, which is written for a **frontend/UI persona** (`domain` includes "frontend"/"react"/"design systems"; `function.block` includes "backend"/"data"/"devops"). Show the user this block and ask them to edit `domain` and `function.block` to match their actual target roles. A mismatch here doesn't error — it silently drops every job with "no domain match", so someone in a different domain would see zero results with no obvious cause. Don't proceed until they've confirmed it reflects their real target roles (or explicitly say the default is fine, e.g. they genuinely are targeting frontend/UI roles). If the file also has `seniority_keywords`, `title_keywords`, or `skills_overlap_threshold` keys (older profiles seeded before these were removed from the template), ignore them — only `title_filter` is read.

**6. First search URL.** Ask for one LinkedIn saved-search URL and a short label, then invoke `/add-url <profile> <url> <label>` (or run `JOBBUNNY_PROFILE=<profile> node scripts/setup/add_url.js "<url>" "<label>"` directly). More can be added later the same way — this just gets the profile past "zero searches."

**7. Notifications (optional).** Ask if they want a Telegram run digest. If yes, run `/notify-setup <profile>`; if no, skip — `/doctor` treats this as optional and won't fail on it.

**8. Verify.** Finish by running `/doctor` yourself and reporting its actual pass/fail output — don't just tell the user to run it later. A red Chrome/CDP check at this point is expected if they haven't logged into LinkedIn in `.chrome-debug/` yet; say so rather than treating it as a setup failure.

Report a short summary at the end: what's done, what's still red (if anything), and the one-line next action (usually `/run <profile>`).
