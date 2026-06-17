---
description: Onboarding wizard — Notion DB, secrets, resume, first URLs. Idempotent (wraps init.js).
---

Run the idempotent setup:

```bash
node scripts/init.js
```

It ensures `.gitignore` ignores `.env` first, prompts (masked) for the Notion token, locates-or-creates the Notion DB under the "Job Bunny's List" page (which must be shared with your integration), persists `NOTION_DB_ID` + `NOTION_PARENT_PAGE_ID`, and seeds any missing scaffold files. Re-running repairs a missing piece without clobbering filled files or duplicating the DB.

Then:
1. Fill `resume.json` (explicit `core_skills` / `secondary_skills` etc.). One-time PDF→resume.json seeding may be offered here — LLM drafts, you verify. Never in the daily path.
2. Run `/update-resume` to generate `resume_meta.json`.
3. Add your first search URLs with `/add-url`.

Setup completing ≠ ready to run: Chrome/CDP readiness is checked separately by `/doctor`.
