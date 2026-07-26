---
description: Structure job data from the compress stage's markdown table into structure/decisions.json (LLM stage — agent inline, no API key).
---

This stage is **LLM-driven and runs inline — you (Claude Code) do it directly, not via a script.** It is the manual/inline equivalent of the pipeline's structure stage (`src/pipeline/stages/structure.ts`, which normally runs via `claude -p` during `jobbunny run`); the file contracts below are that stage's, byte-for-byte, so the assemble stage can parse your output identically.

**Resolve the profile first:** `$ARGUMENTS` = profile name; if none was given, ask — there is no default profile in v2. All files below live in `profiles/<profile>/data/` and are **JSON-wrapped strings** (the Storage port is JSON-only): each file's entire content is one JSON string whose value is the markdown table — read with JSON.parse semantics, write the table JSON-encoded (quoted, `\n` for newlines), never as raw markdown.

**Checkpoint resume:** Before starting, read `structure/decisions.partial.json`. Collect the `id` (first cell) of every data row already present and skip those rows in the input — resume from where a prior attempt left off.

1. Read `structure/table.json` (markdown table written by the compress stage). Columns: `| id | title | company | location | rawText |` (`TABLE_HEADER` in `src/pipeline/stages/compress.ts`). `title`, `company`, and `location` come straight from the search card/lane (`location` is the as-posted location string, empty when the source gave none); `workType` must be derived from title/company/location/rawText.
2. For each remaining row, emit exactly one output row (columns below). One output row per input id — do not skip, merge, or reorder rows.
3. **Checkpoint every 25 rows:** write the accumulated table so far (header + separator + every row emitted, including resumed ones) to `structure/decisions.partial.json`.
4. At completion, write the full table to `structure/decisions.json`, then reset `structure/decisions.partial.json` to just the header + separator (so a stale partial can never shadow a later run).

## Output format (`structure/decisions.json` — parsed per row by `src/pipeline/stages/assemble.ts`)

```
| id | domain | seniority | func | city | country | workType | timezone | skills | salary |
|---|---|---|---|---|---|---|---|---|---|
| 4432229889 | Frontend | Staff | React | Bengaluru | India | onsite | | React; TypeScript | |
```

**Column rules** (same as `buildPrompt` in `structure.ts`):
- `id` — copy the input id exactly, unchanged.
- `domain` — broad domain/space of the role (e.g. `Frontend`, `Backend`, `Data`, `ML`, `DevOps`); empty if unclear.
- `seniority` — free-text seniority level (e.g. `Staff`, `Lead`, `Mid`, `Manager`, `Senior`); empty if unclear.
- `func` — specific function/discipline within the domain (e.g. `React`, `Platform Engineering`, `Growth`); empty if unclear.
- `city` / `country` — the input `location` column is the as-posted job location: PREFER it when filling these; if it resolves only a city, INFER the country from that city; only when `location` is empty, derive city/country from rawText instead; leave city and country empty only when neither location nor rawText resolves them.
- `workType` — one of `onsite`, `hybrid`, `remote` (lowercase); empty if unclear.
- `timezone` — populate ONLY when `workType` = `remote` (e.g. `APAC`, `EMEA`, `US Pacific`); empty otherwise.
- `skills` — semicolon-separated normalized skill names (`React; TypeScript; Node.js`); normalize synonyms (`ReactJS` → `React`).
- `salary` — the salary/compensation range as stated; empty if not mentioned.
- Literal `|` inside a cell — escape as `｜` (fullwidth) so the table can never split.
- Do NOT carry url/company/title through — assemble rejoins those from `structure/passthrough.json` by id; your table is decisions only.
