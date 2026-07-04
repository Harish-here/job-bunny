---
description: Structure job data from compact markdown table into schema-valid jobs_raw_decisions.md (LLM stage — agent inline, no API key).
---

This stage is **LLM-driven and runs inline — you (Claude Code) do it directly, not via a script.** There is no `structure.js`.

**Resolve the profile first:** if a profile name was given (as an argument or by the calling `/run`), use it; otherwise read `default_profile` from `config.json`. All three files below live in `profiles/<profile>/data/` (legacy layout — no `config.json` — uses the repo root as before).

**Checkpoint resume:** Before starting, check if `jobs_raw_checkpoint.md` exists. If it does, load it and collect all `job_id`s already present — skip those rows in the input table (resume from where you left off). Delete `jobs_raw_checkpoint.md` once `jobs_raw_decisions.md` is written successfully.

1. Read `structure_input.md` (markdown table produced by `compress.js`). Columns: `# | id | card_title | company | location | raw_text`. The `card_title`, `company`, and `location` columns come straight from the search card — use them for location/work_type/company when the JD body doesn't restate them.
2. For each row, extract the 11 decision fields (see Output format below).
3. Rules: normalize skill synonyms (e.g. "ReactJS"→"React"); set `yoe_min: true` when the JD says `8+`/`>8` and normalize YoE to the lower bound; populate `tz` only when `work_type = Remote`, else leave empty; set `tz_bad: true` only when the JD explicitly mandates incompatible hours (e.g. "must overlap US Pacific").
4. **Checkpoint every 25 rows:** Write the accumulated rows (header + separator + all rows so far) to `jobs_raw_checkpoint.md`.
5. At completion, write the full table to `jobs_raw_decisions.md` and delete `jobs_raw_checkpoint.md`.

## Output format — markdown table (`jobs_raw_decisions.md`)

```
| job_id | title | company | seniority | city | work_type | yoe | yoe_min | skills | tz | tz_bad |
|--------|-------|---------|-----------|------|-----------|-----|---------|--------|-----|--------|
| 4432229889 | Frontend Architect | Recrew AI | Staff | Bengaluru | On-site | | false | Frontend Architecture | | false |
```

**Column rules:**
- `seniority` — one of `Staff`, `Lead`, `Mid`, `Manager`, `Senior` (byte-exact — these are the Notion select options), or empty
- `yoe` — number or empty (= null)
- `yoe_min` — `true` or `false`
- `skills` — semicolon-separated list: `React; TypeScript; Node.js`
- `tz` — `APAC`, `EMEA`, or empty (= null). Only set when `work_type = Remote`
- `tz_bad` — `true` or `false` (default `false`)
- Pipe character inside a value — use `｜` (fullwidth) to avoid splitting the table
- Do NOT include `job_url`, `date_found`, or `source_query_url` — `assemble.js` merges those from `structure_passthrough.json`

See `fixtures/structure_example.md` for a worked example.
