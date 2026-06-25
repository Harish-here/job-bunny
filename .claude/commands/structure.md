---
description: Structure job data from compact markdown table into schema-valid jobs_raw_decisions.json (LLM stage — agent inline, no API key).
---

This stage is **LLM-driven and runs inline — you (Claude Code) do it directly, not via a script.** There is no `structure.js`.

**Checkpoint resume:** Before starting, check if `jobs_raw_checkpoint.json` exists. If it does, load it and collect all `job_id`s already processed — skip those rows in the table (resume from where you left off). Delete `jobs_raw_checkpoint.json` once `jobs_raw_decisions.json` is written successfully.

1. Read `structure_input.md` (markdown table produced by `compress.js`). Columns: `# | id | card_title | company | location | raw_text`. The `card_title`, `company`, and `location` columns come straight from the search card — use them for location/work_type/company when the JD body doesn't restate them.
2. For each row, structure the data into the Decisions Schema object:
   `job_id (from the id column), job_title, company_name, seniority_level, location_city, work_type (Remote|Hybrid|On-site), years_of_experience (number|null), yoe_is_minimum (bool), key_skills[], timezone_compatibility (APAC|EMEA|null), timezone_incompatible (bool, default false)`.
3. Rules: normalize skill synonyms (e.g. "ReactJS"→"React"); set `yoe_is_minimum: true` when the JD says `8+`/`>8` and normalize YoE to the lower bound; populate `timezone_compatibility` only when `work_type = Remote`, else null; set `timezone_incompatible: true` only when the JD explicitly mandates incompatible hours (e.g. "must overlap US Pacific").
4. **Checkpoint every 25 rows:** Write the accumulated decisions array to `jobs_raw_checkpoint.json`. This enables recovery if context compacts mid-run.
5. At completion, write the full decisions array to `jobs_raw_decisions.json` and delete `jobs_raw_checkpoint.json`.

**Output fields only** (`jobs_raw_decisions.json` — LLM-determined fields, no passthrough):
`job_id, job_title, company_name, seniority_level, location_city, work_type, years_of_experience, yoe_is_minimum, key_skills, timezone_compatibility, timezone_incompatible`

Do NOT include `job_url`, `date_found`, or `source_query_url` in the output — `assemble.js` merges those from `structure_passthrough.json`.

See `fixtures/structure_example.md` for a worked example showing every rule (skill-synonym normalization, `yoe_is_minimum`, Remote-only `timezone_compatibility`, `timezone_incompatible`).
