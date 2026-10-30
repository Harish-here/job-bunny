# QA report — search-link-intake

Author: product-qa · 2026-09-29 · Round 2 (scoped re-verification after fix round 1)

**Verdict: GREEN.** 0 open bugs. All 13 round-1 bugs are resolved.

## 1. Scope Digest

- **Branch / HEAD:** `feat/search-link-intake` @ `2aee43f`. That is round-1 HEAD `26f6cac` plus 7 fix commits: `b10cdf0`, `cbb541e`, `d73179b`, `7ec60dc`, `99ea529`, `c524489`, `2aee43f`. Base: `origin/main` `64eaeb0`.
- **Oracle:** `docs/product/search-link-intake/` (`spec.md`, `ux-notes.md`, `mockup.html`, `blueprint-be.md`, `blueprint.md`) plus `docs/product/personas.md`.
- **Round 2 scope:** B1–B13 checked against their clauses, both live and through their tests, plus the full gate suite. The exploratory pass was aimed at the fixes themselves:
  - the new raw query-string rebuild in `core/linkedin_url`;
  - note preservation in `core/config/search_urls`;
  - the `LanesCard.tsx` / `useSearchUrlRowEditing.ts` split;
  - the save-error split;
  - the Re-file guard.
- **Live-drive safety:**
  - The board ran from the worktree on non-default port **4317**, using a scratch data home: a copy of the committed `rajni` fixture plus seeded runs.
  - The CLI was run against the same scratch home.
  - Never touched: `~/.jobbunny`, `harish`, the daemon, the board on 1994, and Chrome/LinkedIn.

### Pending before merge (held for the user, not bugs)

1. **blueprint-be Step 17:** the R8 `harish` repair. Show a dry-run diff first; write only with the user's explicit approval.
2. **blueprint-be Step 18:** docs-as-code edits (R12) to `CLAUDE.md`'s `ui/` dependency-free-modules list, the explainer KB and `executor.md`. The `CLAUDE.md` edit needs user approval.
3. **blueprint-be §9:** the ATTENDED live LinkedIn verification (AC10).
4. **Decision:** the canary narrows `CLAUDE.md`'s "fail-loud on total outage" invariant for LinkedIn later slots. This needs the user's sign-off.

### Orchestrator decisions applied in fix round 1 (ASSUMED, unattended; recorded, not bugs)

- **B11:** notes and commented-out lines are preserved under their section on `config set` and the API.
- **B2:** Re-file is disabled while the section is dirty, with a hint: "Save or discard your changes first, then re-file."
- **B3:** only a 422 that names one of the current row URLs maps to row copy. Every other failure is a general save error. That error uses the codebase's existing plain `serverError` paragraph, and the Save or Re-file button is the retry.

## 2. Gate Results (verbatim, HEAD 2aee43f)

| Gate | Exit | Result |
|---|---|---|
| `npm run check` | 0 | `ℹ tests 2192 · ℹ pass 2192 · ℹ fail 0 · ℹ skipped 0` |
| `npm run ui:check` | 0 | `Test Files 138 passed (138) · Tests 1257 passed (1257)` |
| `npm run ui:build` | 0 | `✓ 2227 modules transformed … ✓ built in 244ms` |
| `npm run ui:e2e` | 0 | `64 passed (19.5s)` (shared-docs) + `88 passed (13.6s)` (default) = 152. No retries. |

Lint warnings only, no errors:
- `npm run check`: 1 × `noNonNullAssertion`, in `search_urls_normalize.test.ts:92`.
- `ui:check`: 27 warnings, the same classes that existed before this branch.

Named specs:
- `settings-search-link-intake.spec.ts`: 11/11 (3 new).
- `run-bad-links.spec.ts`: 5/5 (2 new).
- `wizard.spec.ts`: 10/10.

Logs are in `scratchpad/gates2/`. This run did not reproduce the round-1 `SkillsSection.test.tsx` flake.

## 3. Traceability Matrix

### Requirements (MoSCoW)

| # | Req | Verdict | Evidence |
|---|---|---|---|
| R1 | Dependency-free classify + clean (Must) | delivered | `probe2.ts`: `keywords=site%20reliability&f_WT=2%2C3&start=25&geoId=1` → `keywords=site%20reliability&f_WT=2%2C3&geoId=1` (byte-identical). `evil-linkedin.com`, `linkedin.com.evil.com` and `ftp:` all throw. `f_TPR=a…` stripped while `f_TPR=r86400` is kept, in either order. |
| R2 | Settings files by derived page type (Must) | delivered | Live save: the `/search-results/` row was filed under `linkedin__jobs-search-results` (Re-filed 1). |
| R3 | API + `config set` normalise and report (Must) | delivered | API PUT reported `cleaned R` and `re-filed R`, and notes and the commented-out link were kept. CLI printed `cleaned A: removed start` and kept its notes. |
| R4 | Every path rejects unclassifiable links, nothing written (Must) | delivered | CLI exit 1 and API 422 for `evil-linkedin.com` and `ftp:`. Settings shows the inline error and a ValidationSummary. |
| R5 | `lane add-url` delegates (Must) | delivered | Live: `stripped currentJobId` → `…keywords=site%20reliability`. |
| R6 | Canary → soft errors, run continues (Must) | delivered (unit) | `fire/lane_canary.test.ts` (a) and (e); `fire/canary.test.ts`. The live check is held (§9). |
| R7 | Genuine outage still loud (Must) | delivered (unit) | `lane_canary.test.ts` (b)–(d); `lane.test.ts:502`. |
| R8 | `harish` repair (Must) | **pending (held)** | Step 17. |
| R9 | Settings shows type / cleaned / refused (Should) | delivered | Live badge, cleaned note and FieldError. |
| R10 | Links identical after cleaning collapse (Should) | delivered | Live: a dirty `%20` copy showed "Same search as "SR A" after cleaning — merged on save.", and on save only SR A is kept. |
| R11 | Digest + run detail name bad links (Should) | delivered | Live panel with a working "+N more" disclosure. `digest.test.ts` passes. |
| R12 | Architecture docs (Should) | **pending (held)** | Step 18. |
| R13 | Flag existing misfiles (Could) | delivered | Live notice, Re-file → "Re-filed 1 link." |

### Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| 1 | delivered | `linkedin_url.test.ts` (in green `check`) and round-1 `probe1.ts`. |
| 2 | delivered | `probe2.ts` line 1: other params byte-identical and in order. The new round-trip tests are in `linkedin_url.test.ts`. |
| 3 | delivered | `feed/`, `example.com`, lookalike hosts, `ftp:` and non-URL strings are all refused with an error naming the input. |
| 4 | delivered | `core/linkedin_url` still imports nothing; `ui:build` passes. |
| 5 | delivered | Live Settings save, doc checked through the API. |
| 6 | delivered | CLI `config set` prints the changes; an unrecognised link exits 1 with nothing written. |
| 7 | delivered | API returns 422 naming the link. |
| 8 | delivered | `lane add-url` tests are green and the source has no own list or map. |
| 9 | delivered | `lane_canary.test.ts` (a)–(d) plus (e). |
| 10 | **pending (held)** | §9 attended live verify. |
| 11 | **pending (held)** | Step 17. |
| 12 | delivered in part | All gates green. The judge-pass record is in the build ledger. |

### Mockup states

| Screen · state | Verdict | Evidence |
|---|---|---|
| S1 default | delivered | Round-1 `shots/app-s1-default.png`. Round-2 live snapshot is unchanged apart from the fixes. |
| S1 empty | delivered | Live: 1 focused row, the copy "No LinkedIn searches yet…", and placeholder "Paste a LinkedIn jobs search link…". The copy hides once a URL is typed. `shots2/b5-empty.png`. |
| S1 loading | delivered | Live: card title, helper and Lanes card stay visible; skeleton rows show inside the card. `shots2/b6-loading.png`. |
| S1 error + Retry | delivered | Live: "Couldn't load search links." inside the card, Lanes visible, Retry reloads the 3 rows. |
| S1 success | delivered | Live: "Saved 4 search links. Re-filed 1, merged 1 duplicate." |
| S1 save-error (R4 refusal) | delivered | Live: a URL-matching 422 shows "1 problem to fix · Comcast X — not a LinkedIn jobs search link". |
| S1 general save failure (500 / network / non-URL 422) | delivered (per ASSUMED B3 decision) | Live: "Couldn't save search links. Check your connection and try again." No row copy, no page error. `shots2/b3-save500-scrolled.png`. |
| Row: typing | delivered | e2e `settings-search-link-intake.spec.ts:370`. |
| Row: clean / cleaned / misfiled | delivered | Live, plus e2e. |
| Row: duplicate + Remove now | delivered | Live, plus e2e. |
| Row: refused | delivered | Live: no error while focused after a paste; the error and `aria-invalid` appear on blur. |
| Misfile notice + Re-file | delivered | Live. Disabled with a hint while any card is dirty (a row edit or a lane toggle); enabled again after Discard; a clean Re-file writes only the re-file. |
| Paste classifies immediately | delivered | Live, plus e2e `:390`. |
| Discard reverts | delivered | e2e `:422`, plus live. |
| S2 default panel + "+N more" | delivered | Live: `+2 more` is a `<button aria-expanded>`. It expands to all 7 links ("Show less") and collapses from the keyboard. |
| S2 Fix in Settings / Copy links | delivered | e2e `run-bad-links.spec.ts:41` and `:136` (clipboard content asserted). |
| S2 empty / loading / error | delivered | e2e `:86` and `:196`. |
| S2 contrast (total outage) | delivered | e2e `:107`. |
| S3 digest variants | delivered | `digest.test.ts`. |

## 4. E2E Coverage Audit

- **Every S1/S2 mockup state now has a pinning e2e test.** The round-1 gaps (B13) are closed:
  - typing (`:370`);
  - real paste (`:390`);
  - Discard reverting a removal (`:422`);
  - Copy links, including the clipboard payload (`run-bad-links.spec.ts:136`);
  - run-detail loading/error with the panel absent (`:196`).
- **S3 digest and the canary outcomes are unit-pinned.** That is appropriate: neither is UI.
- **Two remaining pins are weaker than the behaviour** (notes, not bugs; both verified live this round):
  - Discard reverting a *cleaning* is not pinned; only reverting a removal is.
  - The empty-state copy is pinned by unit tests (`SearchUrlsCard.test.tsx`) rather than by the empty e2e.

## 5. Bug List

Round-1 bugs, re-verified:

| Bug | Sev | Status | Round-2 evidence |
|---|---|---|---|
| B1 query re-encoding breaks AC2/R10 | major | **resolved** | `probe2.ts` byte-identical output. Live dirty `%20` copy is flagged as a duplicate and merged on save. `lane add-url` keeps `%20`. |
| B2 Re-file saves unsaved edits | major | **resolved (ASSUMED decision)** | Disabled with a hint while dirty (row remove, new row, lane toggle); Discard re-enables it; a clean Re-file keeps all rows. |
| B3 every save failure shown as a bad link | major | **resolved (ASSUMED decision)** | 500 / network abort / non-URL 422 show the general error. A URL-matching 422 still maps to the row. |
| B4 onRefile unhandled rejection | minor | **resolved** | Re-file with an aborted PUT: 0 page errors, and the button returns to "Re-file 1 link". |
| B5 empty copy never shown | minor | **resolved** | Live P5 equivalent: copy shown alongside the auto-added row. |
| B6 loading replaced the whole section | minor | **resolved** | `shots2/b6-loading.png`: title 1, helper 1, Lanes card 1. |
| B7 error on paste before blur | minor | **resolved** | Invalid paste: no error and `aria-invalid` null until blur. |
| B8 cleaned note bleeds to original row | minor | **resolved** | Row 0 shows only its badge. Removing a cleaned row does not move a stale note to its neighbour. |
| B9 "+N more" not a disclosure | minor | **resolved** | Live expand/collapse by mouse and keyboard. |
| B10 missing placeholder | minor | **resolved** | `placeholder="Paste a LinkedIn jobs search link…"`. |
| B11 notes dropped silently | minor | **resolved (ASSUMED decision)** | API and CLI keep top and section notes and commented-out links. Normalising is idempotent (repeat runs change nothing). The lane parser still reads only the real bullets. |
| B12 lookalike host / non-http scheme accepted | minor | **resolved** | CLI exit 1 and API 422 for `evil-linkedin.com` and `ftp:`. |
| B13 missing pinning e2e | minor | **resolved** | 5 new e2e tests (§4). |

The round-1 review minor at `search_urls_save.test.ts:55` (a tautological assert) is also fixed: it now reads `assert.notEqual(result.text, input)`.

**New bugs found in round 2: none.**

## 6. Deferred

None. No bug was deferred by the user.

## 7. Residual Risk

- **Riskiest assumption still unverified live:** that re-probing one link already done today reliably tells a bad link apart from an outage (spec §15). The page-specific soft-block case and the throttle cost of the extra navigation are covered only by fake-browser unit tests until the ATTENDED §9 check runs.
- **Settings still drops notes on save.** The Settings editor rebuilds the doc from its rows, so a Settings save silently drops notes that `config set` or the API now keep. This is unchanged from `main`, and the B11 decision was scoped to `config set` and the API. It is a follow-up candidate, not a regression.
- **The general save error is easy to miss.** It sits below the card, and at 1280×900 its top edge is partly under the sticky SaveBar. It uses the codebase's existing `serverError` pattern and has no `role="alert"`.
- **Not verified:** AC10 and AC11 (held), R12 (held), dark theme, the Windows/Linux CI legs, and the flaky `SkillsSection` test, which could still flake on CI.
- **Green means "no known bugs", not "no bugs".**

## 8. Verdict

**GREEN.** 0 open bugs. PR opened from `feat/search-link-intake` to `main` (URL in the orchestrator return). Not merged; merging is the user's decision, after the four Pending-before-merge items.
