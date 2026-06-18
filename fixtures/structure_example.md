# /structure golden example

A worked `raw_text` → `jobs_raw.json` object, demonstrating every normalization rule the
`/structure` stage must apply. Use this as the reference when structuring `jobs_raw_text.json`.

## Input — one `jobs_raw_text.json` record

```json
{
  "job_url": "https://www.linkedin.com/jobs/view/3901234567",
  "source_query_url": "https://www.linkedin.com/jobs/search/?keywords=Staff%20Frontend&f_WT=2",
  "raw_text": "Staff Frontend Engineer — Globex (Remote)\n\nAbout the role: We're hiring a Staff Frontend Engineer to lead our design-system and micro-frontend efforts. 8+ years of frontend experience required. You'll work in ReactJS with TypeScript, build reusable component libraries, and partner across teams.\n\nMust-haves: Expert in React.js and TS, deep experience with design systems and micro frontends, strong JavaScript fundamentals.\nNice-to-have: GraphQL, Node.\n\nThis is a fully remote role open to candidates in India / APAC time zones.",
  "date_found": "2026-06-18"
}
```

## Output — the structured `jobs_raw.json` object

```json
{
  "job_title": "Staff Frontend Engineer",
  "company_name": "Globex",
  "seniority_level": "Staff",
  "location_city": "Remote",
  "work_type": "Remote",
  "years_of_experience": 8,
  "yoe_is_minimum": true,
  "key_skills": ["React", "TypeScript", "Design Systems", "Micro Frontends", "JavaScript", "GraphQL", "Node.js"],
  "job_id": "3901234567",
  "job_url": "https://www.linkedin.com/jobs/view/3901234567",
  "date_found": "2026-06-18",
  "timezone_compatibility": "APAC",
  "source_query_url": "https://www.linkedin.com/jobs/search/?keywords=Staff%20Frontend&f_WT=2",
  "timezone_incompatible": false
}
```

## Rules demonstrated
- **Skill-synonym normalization:** `ReactJS` / `React.js` → `React`; `TS` → `TypeScript`; `micro frontends` → `Micro Frontends`; `Node` → `Node.js`. Normalize so `key_skills` align with `resume_meta.core_skills` for the deterministic rank.
- **`yoe_is_minimum`:** JD says `8+` → `years_of_experience: 8`, `yoe_is_minimum: true`. (`>8` behaves the same.)
- **`timezone_compatibility` only when Remote:** Remote + "India / APAC time zones" → `"APAC"`. If `work_type` were Hybrid/On-site, this MUST be `null`.
- **`timezone_incompatible`:** set `true` ONLY when the JD explicitly mandates incompatible hours (e.g. "must overlap US Pacific 9–5"). Here it doesn't, so `false`. This is the only signal `filter.js` uses to hard-drop a Remote role; absence never drops.
- **`job_id`:** the `/jobs/view/<id>/` segment of `job_url` (`3901234567`).
- **`seniority_level`:** map to one of `Staff | Lead | Mid` (the Notion select). "Senior"/"Sr." collapses to `Mid` for ranking purposes (Staff/Lead = full, else zero).
