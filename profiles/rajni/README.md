# profiles/rajni — committed fixture/test profile

Synthetic, permanent test data for Job Bunny's deterministic pipeline stages
(filter/dedup/rank) and extract's resume/state logic. Not a real person, never
scheduled, never synced to Notion (`profile.json` has `schedule.enabled: false` and
empty Notion IDs), never used for live LinkedIn scraping.

Use this instead of a throwaway `profiles/_verify_test/` profile, and instead of
testing against real user profiles (`harish`, `uvashree`) — see
`.claude/skills/verify/SKILL.md` for the full recipe set.

## Running a stage against it

```bash
JOBBUNNY_PROFILE=rajni node scripts/pipeline/filter.js
JOBBUNNY_PROFILE=rajni node scripts/pipeline/dedup.js
JOBBUNNY_PROFILE=rajni node scripts/pipeline/rank.js
```

Restore pristine state afterward if a stage ever mutates a committed fixture file
(shouldn't happen — filter/dedup/rank are read-only on their inputs):
```bash
git checkout -- profiles/rajni/
```

## Persona

Staff/Lead frontend engineer, 9 years' experience, home cities `["Chennai",
"Bengaluru"]` (array form — both real profiles today use a bare string; this is the
only fixture exercising the array code path in `homeLocations()`/`isHomeCity()`).
Core skills: React, TypeScript, JavaScript, UI Architecture, Design Systems.
Secondary skills: Vue.js, Redux Toolkit, Storybook, Jest, Node.js.

## `data/jobs_raw.json` — expected outcomes

11 records exercise `filter.js` + `rank.js`:

| job_id | work_type / city | Expected `filter.js` outcome | Expected `rank.js` note |
|---|---|---|---|
| rajni-1001 | On-site, Chennai (home) | kept | baseline — high score |
| rajni-1002 | On-site, Mumbai | **dropped** — on-site outside home city | — |
| rajni-1003 | On-site, Bengaluru (home #2) | kept | proves the 2nd array city is home |
| rajni-1004 | Remote, `timezone_incompatible: true` | **dropped** — remote + incompatible hours | — |
| rajni-1005 | Remote, tz `APAC` | kept | full remote+tz score (20) |
| rajni-1006 | Remote, tz `EMEA` | kept | partial remote+tz score (10) |
| rajni-1007 | Hybrid, Pune (not home) | kept (Hybrid never dropped on location) | 0 on work-type axis |
| rajni-1008 | Hybrid, Chennai (home) | kept | full work-type score |
| rajni-1009 | Remote, "Software Engineer II" title | **dropped** — title/seniority gate fail | — |
| rajni-1010 | Remote, tz `APAC`, skills=Storybook/Jest only | kept | rank hard-capped at 50 (zero core-skill match) |
| rajni-1011 | Remote, tz `APAC`, `years_of_experience: null` | kept | YoE axis neutral (5pts) |

3 records + 2 `cache.json` seeds exercise `dedup.js`:

`cache.json` seeds: (A) `rajni-9001`, Staff Frontend Engineer @ Ironclad Payments,
Chennai; (B) `rajni-0099`, Lead Frontend Engineer @ Solstice Ventures, Bengaluru.

| job_id | work_type / city | Expected `dedup.js` outcome |
|---|---|---|
| rajni-1012 | On-site, Chennai (fresh id) | **dropped** — repost of cache (A): same title+company+city, different id |
| rajni-0099 | On-site, Bengaluru, id matches cache (B) exactly | **dropped** — exact cache-hit (job_id match) |
| rajni-1014 | On-site, Bengaluru (fresh id) | kept — same title+company as (A), but different city is NOT a repost |

**Totals:** 14 records in → 11 survive `filter.js` (drops 1002/1004/1009) → 9 survive
`dedup.js` (additionally drops 1012 and the 0099 duplicate) → 9 reach `rank.js`.

## Extract's resume/state logic

Not covered by a committed fixture — `extract_resume.json`'s `day` field must equal
"today" to test the crash-resume/already-complete paths, so a committed file would go
stale the day after commit. See the on-the-fly recipe in
`.claude/skills/verify/SKILL.md`.

## Out of scope

- Live browser-driven `/extract` (no working LinkedIn session, `search_urls.md`'s URLs
  are never fetched — they only exist so `searchUrlsHash` has something real to hash).
- `/sync`/`/reconcile` against a real Notion DB.
- `/greenhouse` (no `greenhouse_boards.md`).
- Stage-A `avoid.js` card-level testing — that operates on pre-assemble data this
  profile doesn't model; `avoid.test.js` already covers it directly.
