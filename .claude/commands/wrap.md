---
description: Session close-out — update design doc, log, roadmap, and/or ship a release to Notion + git.
---

This is an **inline LLM command** — you (Claude) do all the work directly. No script. You use Notion MCP tools and Bash (git). Never edit from memory; always fetch a page in full before touching it.

---

## Notion page IDs (hardcoded — do NOT read these from .env, which holds job-pipeline IDs only)

- **Job Bunny main page:** `37ccbef6-4ec2-8039-aa4c-d2f6d66bee2d`
- **Roadmap subpage:** `381cbef6-4ec2-81d1-b3a5-ebd4f3d0fd1e`
- **Active design doc:** resolved at runtime from the Design Versions table on the main page

---

## Safety rules (apply to every mode)

- Write targets: active design doc (full mode only) + main page log + roadmap (improve/ship/full). **No other Notion page without explicit user say-so.**
- Notion write ops allowed: `insert_content` (append) and anchored `update_content` only. Never `replace_content` (unbounded blast radius). Never `allow_deleting_content: true`.
- On a no-match anchor error: re-fetch the page, inspect the real markup, narrow the anchor. Never broaden or fall back to a full replace.
- Show the payload (target page, op, anchor, new content) **before** executing any structural or table edit. Trivial log appends may skip the preview.
- Post-verify by re-fetching after structural edits; trust the tool return for simple appends.

---

## Mode: no argument — mode picker

When invoked as `/wrap` with no argument, ask the user exactly this and wait for their answer before doing anything else:

> What are we wrapping up today?
> 1. **full** — design doc + log (design-only session)
> 2. **log** — quick log note only
> 3. **improve** — add an improvement to the roadmap
> 4. **ship** — tag a release + update Notion + log

Then proceed exactly as if the user had typed `/wrap <chosen-mode>`.

---

## Mode: `/wrap full`

Design-session close-out. Updates the active design doc surgically and appends a dated entry to the main page log.

**1. Validate the Design Versions table**
`notion-fetch` the main "Job Bunny" page. Locate the Design Versions table (first table at the top). Count rows where Status = 🟢 Active.
- Not exactly one → stop. List the offending rows. Ask the user to fix the table before proceeding.
- Exactly one → extract the linked design doc page ID from that row.

**2. Read before editing**
`notion-fetch` the active design doc in full. The log lives on the main page (already fetched in step 1 — no second fetch needed).

**3. Update the design doc (surgical)**
For each decision made this session that supersedes an existing section: use anchored `update_content` targeting the exact section heading or the specific line. Append a new section only for content that has no prior section covering it — never as a substitute for an anchored replace. Never blind-overwrite the whole doc.

**4. Append to the log**
Add one entry at the bottom of the main page.
Heading format: a Notion **date mention** for today (inline `@today` mention — use a rich_text mention object with `{ type: "date", date: { start: "<YYYY-MM-DD>" } }` where YYYY-MM-DD is today's date) followed by plain text ` (session <N> — <short label>)`.
Derive N by counting existing entries that match the date-mention `(session …)` pattern in the already-fetched page content, then add 1. If you cannot count reliably (page truncated, inconsistent formatting), omit the session number and use the date mention followed by ` — <short label>` instead.
Never alter any prior entry. End with `Next: <decision>` only if the very next step is itself a decision worth recording.

**5. Confirm**
- `design doc: <what changed>` (or `no design changes`)
- `log: <entry summary>`

---

## Mode: `/wrap log`

Quick log-only note. No design doc, no git, no roadmap, no classification.

**1. Read first**
`notion-fetch` the main "Job Bunny" page in full.

**2. Append one dated entry**
Heading format: a Notion **date mention** for today (inline `@today` mention — use a rich_text mention object with `{ type: "date", date: { start: "<YYYY-MM-DD>" } }` where YYYY-MM-DD is today's date) followed by plain text ` (session <N> — <short label>)` + bullet points.
Derive N by counting existing entries matching the date-mention `(session …)` pattern in the fetched page content, then add 1. If counting is unreliable, use the date mention followed by ` — <short label>` instead. Append-only — never alter prior entries. Conditional `Next:` rule applies.

**3. Confirm**
- `log: <entry summary>`

---

## Mode: `/wrap ship`

Dedicated release flow. Run after code work is done and ready to tag.

**1. Read git history since last tag**
Run:
```bash
git describe --tags --abbrev=0 2>/dev/null || echo "__no_tags__"
```
If the output is `__no_tags__`, run `git log --oneline` instead (all commits) and tell the user: "No prior tag found — will start versioning from scratch; suggest `v0.1.0` or confirm a different base version." Otherwise run:
```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```
Show the commit list to the user as context.

**2. Classify the bump**
Ask: **"Is this a major (new design version), minor (new feature), or patch (fix/hardening)?"**
Recommend based on the commit content. Derive the new version string from the last tag (e.g. `v0.1.0` + minor → `v0.2.0`). Confirm the new version string with the user before any writes.

**3. Generate release summary**
Draft a concise summary: what shipped, why it matters, any known gaps. Show for user approval before writing anywhere.

**4. Update CHANGELOG.md**
Read `CHANGELOG.md` first to confirm the current format. Mirror the `[0.1.0]` block exactly: a `## [X.Y.Z] — YYYY-MM-DD` heading, then `### Added` / `### Fixed` / `### Notes` sub-sections as applicable (omit empty sub-sections). Prepend the new block. Stage and commit before tagging:
```bash
git add CHANGELOG.md
git commit -m "chore: CHANGELOG for vX.Y.Z"
```

**5. Validate Design Versions table (before tagging)**
`notion-fetch` the main "Job Bunny" page. Confirm exactly one 🟢 Active row. If not → stop and ask the user to fix it before proceeding. Do not create the git tag until this check passes.

**6. Git tag**
```bash
git tag vMAJOR.MINOR.PATCH
```
On a major bump: also confirm the `vMAJOR.0.0` convention with the user. Then push both the CHANGELOG commit and the tag:
```bash
git push && git push origin vMAJOR.MINOR.PATCH
```
If the repo has no remote configured, skip the push and note it in the confirm output.

**7. Update Design Versions table**
- **All bumps:** update the "Active version" column in the 🟢 Active row to the new version string (e.g. `0.2.0`) via anchored `update_content`. Use the current cell value as the anchor; if the cell is empty, anchor on the Code Tag value of that row (unique per row).
- **Major bump only:** also flip the Active row to ✅ Shipped → promote the Draft row with the **lowest version number** (e.g. if v1/v2/v3 are all Draft, promote v1) to 🟢 Active. Set "Active version" in the newly promoted row to the new version string. If it is unclear which row to promote, stop and ask the user before writing. Confirm exactly one Active row after both writes.

**8. Mark roadmap items done**
`notion-fetch` the roadmap page. In the "v0 LinkedIn lane — hardening increments" table, find the shipped version's row. Append `✅ shipped in vX.Y.Z` to its Items cell via anchored `update_content`. Never delete rows. If the shipped version has no hardening row (e.g. it was a design-only minor), skip this step.

**9. Append to the log**
One dated entry on the main page: a Notion **date mention** for today (inline `@today` mention — use a rich_text mention object with `{ type: "date", date: { start: "<YYYY-MM-DD>" } }` where YYYY-MM-DD is today's date) followed by plain text ` (ship — vX.Y.Z)` + 2–3 bullet summary. End with `Next: <next roadmap version and theme>` pulled from the remaining unshipped rows in the hardening increments table.

**10. Confirm**
- `git: tagged vX.Y.Z` (+ pushed, or `no remote — push skipped`)
- `CHANGELOG.md: added vX.Y.Z block`
- `design versions table: Active version → vX.Y.Z` (+ `row flipped` on major bump, or `no row flip` on minor/patch)
- `roadmap: marked vX.Y.Z items shipped` (or `no hardening row — skipped`)
- `log: <entry summary>`
- `Next up: <next version and theme>`

---

## Mode: `/wrap improve`

Capture a pipeline improvement (surfaced by a run or a review) into the roadmap, then log it.

**1. Read the roadmap**
`notion-fetch` the roadmap page in full. Show the user the sub-version rows from the "v0 LinkedIn lane — hardening increments" table.

**2. Ask which sub-version**
Ask: **"Which immediate sub-version should this improvement go under?"**
The user picks an existing version (e.g. `0.3.0`) or names a new one (e.g. `0.6.0`).

**3. Update the roadmap**
- Existing version row: anchored `update_content` on the Items cell — append the new item (scoped, small anchor).
- New version row: append a new table row with Version, Theme (ask if unclear), Items, and Why filled.

**4. Append to the log**
`notion-fetch` the main "Job Bunny" page (read first). Append a brief dated log entry summarising the improvement and which version it targets.

**5. Confirm**
- `roadmap: added to v<X.Y.Z>`
- `log: <entry summary>`
