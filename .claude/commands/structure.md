---
description: Structure raw JD text into schema-valid jobs_raw.json (LLM stage — agent inline, no API key).
---

This stage is **LLM-driven and runs inline — you (Claude Code) do it directly, not via a script.** There is no `structure.js`.

1. Read `jobs_raw_text.json` (array of `{ job_url, source_query_url, raw_text, date_found }`).
2. For each record, structure `raw_text` into the Extraction Schema object:
   `job_title, company_name, seniority_level, location_city, work_type (Remote|Hybrid|On-site), years_of_experience (number|null), yoe_is_minimum (bool), key_skills[], job_id (string|null), job_url, date_found, timezone_compatibility (APAC|EMEA|null), source_query_url`.
3. Rules: normalize skill synonyms here (e.g. "ReactJS"→"React"); set `yoe_is_minimum: true` when the JD says `8+`/`>8` and normalize YoE to the lower bound; populate `timezone_compatibility` only when `work_type = Remote`, else null; set `timezone_incompatible: true` only when the JD explicitly mandates incompatible hours (e.g. "must overlap US Pacific").
4. Write the array to `jobs_raw.json`. Each object must be schema-valid.
