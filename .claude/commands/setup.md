---
description: Onboarding wizard — per-profile Notion page + DB, secrets, resume, first URLs. Idempotent (wraps init.js).
---

Run the idempotent per-profile setup (`$ARGUMENTS` = profile name, lowercase/digits/hyphens):

```bash
node scripts/init.js <profile>
```

It ensures `.gitignore` ignores `.env`, `profiles/`, and `config.json` first, prompts (masked) for the shared Notion token, scaffolds `profiles/<profile>/` (avoid.md, search_urls.md, filter_config.json from `templates/`, empty data/cache.json), writes `config.json` (default profile) if missing, then locates-or-creates the profile's own Notion page (a child of "Job Bunny's List", which must be shared with your integration) with a "Job Bunny — Jobs" DB inside it, persisting both IDs to `profiles/<profile>/profile.json`. Re-running repairs a missing piece without clobbering filled files or duplicating Notion structure.

A pre-v0.7 checkout (root-level config files) must run `/migrate <name>` first — init refuses to mix layouts.

Then:
1. Fill `profiles/<profile>/resume.json` (start from `resume.example.json`; explicit `core_skills` / `secondary_skills` etc.). One-time PDF→resume.json seeding may be offered here — LLM drafts, you verify. Never in the daily path.
2. Run `/update-resume <profile>` to generate its `resume_meta.json`.
3. Add its first search URLs with `/add-url <profile> <url> <label>`.

Setup completing ≠ ready to run: Chrome/CDP readiness is checked separately by `/doctor`.
