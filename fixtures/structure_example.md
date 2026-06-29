# /structure golden example

A worked `raw_text` → `jobs_raw_decisions.md` row, demonstrating every normalization rule the
`/structure` stage must apply.

## Input — one row from `structure_input.md`

| # | id | card_title | company | location | raw_text |
|---|----|-----------|---------|----------|----------|
| 1 | 3901234567 | Staff Frontend Engineer | Globex | India (Remote) | Staff Frontend Engineer — Globex (Remote) About the role: We're hiring a Staff Frontend Engineer to lead our design-system and micro-frontend efforts. 8+ years of frontend experience required. You'll work in ReactJS with TypeScript, build reusable component libraries, and partner across teams. Must-haves: Expert in React.js and TS, deep experience with design systems and micro frontends, strong JavaScript fundamentals. Nice-to-have: GraphQL, Node. This is a fully remote role open to candidates in India / APAC time zones. |

## Output — `jobs_raw_decisions.md`

| job_id | title | company | seniority | city | work_type | yoe | yoe_min | skills | tz | tz_bad |
|--------|-------|---------|-----------|------|-----------|-----|---------|--------|-----|--------|
| 3901234567 | Staff Frontend Engineer | Globex | Staff | Remote | Remote | 8 | true | React; TypeScript; Design Systems; Micro Frontends; JavaScript; GraphQL; Node.js | APAC | false |

## Rules demonstrated

- **Skill-synonym normalization:** `ReactJS` / `React.js` → `React`; `TS` → `TypeScript`; `micro frontends` → `Micro Frontends`; `Node` → `Node.js`. Normalize so `skills` align with `resume_meta.core_skills` for deterministic ranking.
- **`yoe_min`:** JD says `8+` → `yoe: 8`, `yoe_min: true`. (`>8` behaves the same.)
- **`tz` only when Remote:** Remote + "India / APAC time zones" → `tz: APAC`. If `work_type` were Hybrid or On-site, `tz` MUST be empty.
- **`tz_bad`:** `true` ONLY when the JD explicitly mandates incompatible hours (e.g. "must overlap US Pacific 9–5"). Absent = `false`. This is the only signal `filter.js` uses to hard-drop a Remote role.
- **`job_id`:** the `/jobs/view/<id>/` segment of the job URL.
- **`seniority`:** map to `Staff | Lead | Mid`. "Senior"/"Sr." → `Mid`.
- **Skills as semicolons:** `React; TypeScript; Design Systems; ...` — `assemble.js` splits on `;`.
- **Pipe in value:** use `｜` (fullwidth) if a skill or title contains a literal `|`.
