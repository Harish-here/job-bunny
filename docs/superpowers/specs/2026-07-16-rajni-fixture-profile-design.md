# `profiles/rajni/` — Committed Fixture/Test Profile

## Context

Verifying a change to the pipeline currently means hand-building a throwaway profile
(`profiles/_verify_test/`) each time — seeding `avoid.md`, `filter_config.json`,
`search_urls.md`, and `data/*.json` fixtures from scratch, running the stage under test,
then deleting it. This is exactly what happened while verifying the extract-resume
multi-fire-skip fix: useful evidence, but wasted effort re-derived every session, and it
never accumulates into a reusable, reviewable fixture.

`profiles/` is also entirely `.gitignore`d today — every real profile (`harish`,
`uvashree`) contains personal resume data and live Notion IDs, so nothing under
`profiles/` is ever committed; `templates/` + `resume.example.json` ship blank
placeholder seeds for `/setup` instead.

The goal: a small, permanent, synthetic profile — **`profiles/rajni/`** — committed to
the repo, that becomes the standard target for all future live testing of the
deterministic pipeline stages (filter, dedup, rank) and the extract resume/state logic,
replacing both the throwaway-profile pattern and any temptation to test against real
user profiles. Its data is also a realistic worked example of a fully-populated profile —
useful reference material alongside the blank `templates/` seeds for understanding what a
profile looks like end-to-end.

## Scope

**In scope:** fixture data + docs for `filter.js`, `dedup.js`, `rank.js`, and
`shouldResetResume`'s resume/reset logic (`extract/state.js`) — the deterministic stages
identified as the actual reusable-testing need.

**Out of scope:**
- Live browser-driven `/extract` against real LinkedIn (Rajni never gets a working
  session or genuine scrape traffic — its `search_urls.md` exists only so
  `searchUrlsHash`/`applyWindowOverride` have something real to hash against, not to be
  fetched).
- `/sync`/`/reconcile` against a real Notion DB (`profile.json`'s Notion IDs stay empty;
  invoking `/sync` against `rajni` is simply unsupported, not a case this profile needs to
  handle gracefully).
- Changing `/setup`'s actual seeding mechanism (`templates/*.json` + `resume.example.json`
  stay exactly as they are — Rajni is a parallel worked example, not a new seed source).
- `/greenhouse` (optional, fail-soft lane — no `greenhouse_boards.md` needed).

## File layout

```
profiles/rajni/
  profile.json          # schedule.enabled: false, empty Notion IDs, notify disabled
  avoid.md               # 2-3 avoid-companies + one alias-map entry (reference only —
                          # avoid-list applies to pre-assemble card data, so no jobs_raw.json
                          # record can legitimately represent an avoid hit; avoid.test.js
                          # already covers avoid.js's logic directly)
  filter_config.json     # seniority/domain/function terms for the Rajni persona
  search_urls.md          # 2 labeled URLs under the existing shared linkedin__jobs-search
                          # inventory — never fetched, just gives searchUrlsHash something
                          # real to hash
  resume.json            # synthetic "Rajni" persona, full_resume shape
  resume_meta.json        # location as a multi-city ARRAY (["Chennai","Bengaluru"]) —
                          # currently zero production coverage of the array form
  data/
    cache.json            # 2 "already known" jobs — dedup's cache-hit + repost paths
    jobs_raw.json          # 14 records — the variation matrix (below)
  README.md              # data dictionary: each record's purpose + expected per-stage
                          # outcome; scope/no-live-scraping note; reset instructions
```

No `data/jobs_raw_text.json` / `extract_resume.json` / `companies_seen.json` are
committed — the extract-resume "already-complete" scenario is inherently date-relative
(`extract_resume.json`'s `day` field must equal "today" or it trips the unrelated
"new-day" reset instead), so a committed file would silently go stale the day after
commit. That scenario instead becomes a short **documented recipe** in
`.claude/skills/verify/SKILL.md`: compute `searchUrlsHash` from Rajni's real
`search_urls.md`, write a resume file stamped with today's date and every URL marked
done, run `/extract` against it, observe the log line, then `git checkout --
profiles/rajni/` to discard the generated file (Rajni's own committed files are never
touched by this recipe, since the generated resume file lives only in the untracked
working tree until discarded).

## `.gitignore` changes

Two problems block committing anything under `profiles/rajni/` today:

1. `profiles/` (trailing slash, no wildcard) excludes the directory itself — once a
   directory is excluded, git does not recurse into it at all, so no negation for a path
   *inside* it can take effect (git's documented "cannot re-include a file if a parent
   directory is excluded" rule). Fix: change it to `profiles/*`, which excludes each
   profile *by name* (`profiles/harish`, `profiles/uvashree`, `profiles/rajni`, …)
   individually — `profiles/rajni` then becomes a directly-excluded entry (not a child of
   an excluded parent), which *can* be re-included.
2. Even with that fix, two of Rajni's files still collide with unrelated blanket
   bare-filename rules that appear later in the file (`resume.json` in the "Personal
   data" section, `jobs_raw.json` in the "Per-run intermediate artifacts" section) —
   gitignore is last-match-wins per path, so the negations must be placed after every
   rule that would otherwise re-shadow them: at the very end of the file.

```diff
 # Profiles — all profile config/data is local-only; templates/ ships the seeds
-profiles/
+profiles/*
 config.json
```

```diff
 # Chrome remote-debug profile (local only)
 .chrome-debug/
+
+# profiles/rajni/ is a committed, synthetic fixture profile for live-testing the
+# deterministic pipeline stages + onboarding reference (see profiles/rajni/README.md).
+# Must come after every blanket rule above that would otherwise re-shadow these paths
+# (gitignore is last-match-wins per path) — do not move these earlier in the file.
+!profiles/rajni/
+!profiles/rajni/resume.json
+!profiles/rajni/data/jobs_raw.json
```

`profiles/rajni/data/cache.json` needs no negation — the existing `data/cache.json` rule
contains a `/` in the middle, which anchors it to the repo root; it never matches
`profiles/rajni/data/cache.json`.

## Persona (`resume_meta.json` / `resume.json`)

Senior frontend/UI engineer, 9 years' experience, targeting Staff/Lead roles:

```json
{
  "current_yoe": 9,
  "target_seniority": ["Staff", "Lead"],
  "core_skills": ["React", "TypeScript", "JavaScript", "UI Architecture", "Design Systems"],
  "secondary_skills": ["Vue.js", "Redux Toolkit", "Storybook", "Jest", "Node.js"],
  "preferred_work_type": ["Remote", "Hybrid"],
  "location": ["Chennai", "Bengaluru"],
  "domain_experience": ["Enterprise SaaS", "Fintech"],
  "usp": [
    "Led the UI platform re-architecture behind a multi-brand storefront rollout.",
    "Built a shared design-system library adopted across four product teams."
  ]
}
```

`resume.json`'s `full_resume` block mirrors this with clearly-fictional contact details
(no real name/email/phone — a placeholder persona, not a real person).

`filter_config.json`'s `title_filter`: `seniority: ["staff","lead","principal","architect"]`,
`domain: ["frontend","front-end","ui","react","design systems"]`,
`function.allow: ["engineer","developer","architect"]`,
`function.block: ["manager","director","vp","analyst","qa","devops","data","recruiter"]`.

## `data/jobs_raw.json` — the variation matrix (14 records)

**Filter + rank coverage (11 records):**

| job_id | Title / Company | work_type / city | Exercises |
|---|---|---|---|
| rajni-1001 | Staff Frontend Engineer @ Atlas Retail Technologies | On-site, Chennai (home #1) | Baseline — survives every stage, high score |
| rajni-1002 | Lead Frontend Engineer @ Vertex Systems Pvt Ltd | On-site, Mumbai | Filter drop: on-site outside home city |
| rajni-1003 | Staff UI Engineer @ Meridian Cloud Labs | On-site, Bengaluru (home #2) | Proves the 2nd array city counts as home |
| rajni-1004 | Lead React Engineer @ NorthPeak Software | Remote, `timezone_incompatible: true` | Filter drop: remote + incompatible hours |
| rajni-1005 | Principal Frontend Architect @ Bluewave Fintech | Remote, tz `"APAC"` | Rank: full remote+tz score (20) |
| rajni-1006 | Staff Frontend Engineer @ Solace Data Systems | Remote, tz `"EMEA"` | Rank: partial remote+tz score (10) |
| rajni-1007 | Lead UI Engineer @ Ferrovia Robotics | Hybrid, Pune (not home) | Filter keeps Hybrid regardless of city; rank scores 0 on work-type axis |
| rajni-1008 | Staff Frontend Engineer @ Coral Reef Analytics | Hybrid, Chennai (home) | Rank: full work-type score |
| rajni-1009 | Software Engineer II, Frontend @ Palisade Systems | Remote | Filter drop: title/seniority gate fail |
| rajni-1010 | Staff Frontend Engineer @ Vantage Analytics Group | Remote, tz `"APAC"`, skills = Storybook/Jest only | Rank: zero-core-skill hard cap at 50 |
| rajni-1011 | Lead Frontend Engineer @ Hollow Peak Studio | Remote, tz `"APAC"`, `years_of_experience: null` | Rank: YoE neutral (5pts) |

**Dedup coverage (3 records + 2 `cache.json` seeds):**

`cache.json` seeds: (A) `job_id: "rajni-9001"`, Staff Frontend Engineer @ Ironclad
Payments, Chennai; (B) `job_id: "rajni-0099"`, Lead Frontend Engineer @ Solstice
Ventures, Bengaluru.

`dedup.js` only ever sees what already survived `filter.js` — so each of these three
records independently needs a filter-passing `work_type`/city combination in its own
right (On-site in a home city), on top of the title/company/city triple that drives the
dedup decision:

| job_id | Title / Company | work_type / city | Exercises |
|---|---|---|---|
| rajni-1012 | Staff Frontend Engineer @ Ironclad Payments | On-site, Chennai (fresh id) | Repost drop — same title+company+city as cache (A), different id |
| rajni-1013 | Lead Frontend Engineer @ Solstice Ventures | On-site, Bengaluru, `job_id: "rajni-0099"` | Exact cache-hit drop — job_id matches (B) directly |
| rajni-1014 | Staff Frontend Engineer @ Ironclad Payments | On-site, Bengaluru (fresh id) | NOT a repost — same title+company as (A), different city → kept, reaches rank |

Every record uses the exact Notion-enum-byte-exact literals (`"On-site"|"Remote"|"Hybrid"`,
`"Staff"|"Lead"`, `"APAC"|"EMEA"`) so a lowercase/typo'd fixture value can't silently fall
into the wrong scoring bucket.

## Companion docs

- **`profiles/rajni/README.md`** — the data-dictionary table above (record → expected
  outcome per stage), the scope note (no live scraping, no Notion sync), the extract-resume
  recipe pointer, and the reset instruction: after running any stage against
  `profiles/rajni/`, restore pristine state with `git checkout -- profiles/rajni/`.
- **`.claude/skills/verify/SKILL.md`** — rewritten so `profiles/rajni/` is the default
  target for filter/dedup/rank/extract-resume-logic verification; the existing
  throwaway-profile pattern is kept as a documented fallback for scenarios Rajni's fixture
  doesn't cover (e.g. a genuinely novel one-off scenario, or Stage-A avoid.js card-level
  testing, which operates on pre-assemble data Rajni doesn't model).
- **`CLAUDE.md`** — one line added to "Profiles & paths" noting `profiles/rajni/` as the
  committed exception to the local-only rule, pointing at its README.

## Testing / verification plan

- No new unit tests — this is fixture data, not code. Verification is running the real
  stage scripts against it and diffing observed output against the README's documented
  expectations:
  ```
  JOBBUNNY_PROFILE=rajni node scripts/pipeline/filter.js
  JOBBUNNY_PROFILE=rajni node scripts/pipeline/dedup.js
  JOBBUNNY_PROFILE=rajni node scripts/pipeline/rank.js
  ```
  Confirm `filtered_jobs.json` drops exactly rajni-1002/1004/1009 (11 of 14 records
  survive); confirm `new_jobs.json` additionally drops rajni-1012 (repost) and rajni-1013
  (cache-hit) (9 of 11 survive dedup), and that rajni-1010 is present in the final ranked
  output but capped at score 50.
- Confirm `git status` is clean after `git checkout -- profiles/rajni/` post-run.
- Confirm `npm test` still passes (no code changes, but the `.gitignore` edit and new
  committed files must not break anything path-resolution-related).
- Manually exercise the extract-resume documented recipe once, exactly as
  `.claude/skills/verify/SKILL.md` will describe it, to confirm the recipe itself works
  before shipping it as documentation.
