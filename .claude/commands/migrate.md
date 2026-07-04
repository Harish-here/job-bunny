---
description: One-shot conversion of a pre-v0.7 checkout to the profiles layout. Moves root config into profiles/<name>/.
---

Run the migration (`$ARGUMENTS` = profile name for the existing setup, lowercase/digits/hyphens — e.g. your first name):

```bash
node scripts/migrate.js <name>
```

Moves the root-level `resume.json`, `resume_meta.json`, `avoid.md`, `filter_config.json`, `search_urls.md`, and `data/cache.json` into `profiles/<name>/`, writes `profiles/<name>/profile.json` from the `.env` Notion IDs (the env keys stay in place but are ignored afterwards), and writes `config.json` making `<name>` the default profile. Files deleted by the upgrade pull are re-seeded from `templates/`. Refuses to run twice. Rollback steps are in the script header.

Verify afterwards with `/doctor`.
