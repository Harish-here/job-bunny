# UX notes — search-link-intake

Slug `search-link-intake` · Author: product-ux · 2026-09-28 · Spec: `docs/product/search-link-intake/spec.md`
Mode: UNATTENDED — every open design question decided on its recommended default, logged as
**ASSUMED (unattended)**. Persona: P1, tuner hat (Settings) then operator hat (Telegram → run detail).

## 0. Scope and journey

UX scope: spec R2, R4, R9, R10, R11, R13 plus the §15 usability concerns. There is no page-type override (spec §14).

Journeys:
- **J1 Add (tuner hat).** Copy a link from LinkedIn, then Board › Settings › *Where jobs come from* ›
  Search URLs card. Add a row, paste the link, then tab to Label. The link is classified and cleaned on
  blur. Type a label, then Save.
- **J2 Bad link later (operator hat).** A Telegram digest arrives with the run passed but naming the
  failed links. Open the board run detail and read the *Links that failed* panel. Its button goes to
  the same Settings card.
- **J3 Legacy misfile (R13).** Open Settings. A card notice says N links are filed wrong. Click
  **Re-file N links** once and it is done.

Target surface: `WhereJobsComeFromSection.tsx`, card 2 "Search URLs" (nav: Runs › Where jobs come from,
route `#/settings/where-jobs-come-from`). Recon found that `SearchUrlsSection.tsx` has a duplicate of the same row
editor. The design applies to the one row editor. See NOTES for the duplication smell.

## 1. Design Scale (effective, from recon — the mockup uses nothing else)

Source: `ui/src/index.css`, `docs/product/ui-design-system/reference.md`, Tailwind 4px grid.

| Kind | Literal | Token / utility | Use here |
|---|---|---|---|
| space | 4px | `gap-1` / `p-1` | icon↔text, note line gap |
| space | 6px | `gap-1.5` | label↔control |
| space | 8px | `gap-2` / `p-2` | row fields, badge row |
| space | 10px | `px-2.5` | input/button horizontal padding |
| space | 12px | `gap-3` / `p-3` | row card padding, SaveBar |
| space | 16px | `gap-4` / `p-4` | card padding, list gap, notices |
| space | 24px | `gap-6` / `p-6` | page padding, frame gap |
| height | 32px | `h-8` | inputs |
| height | 36px | `h-9` | buttons (sm) |
| height | 20px | `h-5` | badge |
| width | 192px | `w-48` | Label input |
| width | 224px | `grid-cols-[224px_1fr]` | settings sidebar |
| type | 11px / 16px, 500, uppercase, 0.04em | `text-micro` | eyebrows ("PAGE TYPE" not used — see C3) |
| type | 12px / 16px, 400/500 | `text-xs` | badges, row notes, helper |
| type | 14px / 20px, 400/500 | `text-sm` | body, inputs, notices |
| type | 16px / 22px, 500 | `text-base leading-snug` | card titles |
| type | 18px / 28px, 600 | `text-lg` | page / pane titles |
| radius | 9.6px | `rounded-sm` (`--radius-sm`) | kbd, small chips |
| radius | 16px | `rounded-lg` (`--radius-lg`) | inputs, buttons, row cards, notices |
| radius | 22.4px | `rounded-xl` (`--radius-xl`) | cards |
| radius | 41.6px | `rounded-4xl` | badges |
| colour | #faf8fd / #1a1523 | `--background` | page |
| colour | #3d2c55 / #e6ddf5 | `--foreground` | text |
| colour | #ffffff / #241d30 | `--card` | cards |
| colour | #f1ecf8 / #2e2540 | `--muted` | input fill, skeleton |
| colour | #6e5b87 / #a695c2 | `--muted-foreground` | meta, "cleaned" note |
| colour | #e4dbf0 / #362c4a | `--border` | rules |
| colour | #7b5ea7 / #b79ce0 | `--primary` / `--ring` | primary action, focus ring |
| colour | #ffffff / #1a1523 | `--primary-foreground` | text on primary |
| colour | #4caf6e / #6fcb8e | `--success` (fill, `/10` tint) | save-success strip |
| colour | #26703f / #6fcb8e | `--success-strong` | success text |
| colour | #d64545 / #f08a8a | `--destructive` (fill, `/8` tint, `border-l-2`) | refused / error fill |
| colour | #c62c2c / #f08a8a | `--destructive-strong` | error text |
| colour | #ff8a3d / #ff9e5e | `--attention` (fill, `/10` tint, `border-l-2`) | misfile / bad-link notice |
| colour | #a04a06 / #ff9e5e | `--attention-strong` | attention text |
| colour | #f3eefb / #201a2c | `--sidebar` | settings nav |
| colour | #e7def7 / #2e2540 | `--sidebar-accent` | active nav item |
| focus | 3px ring at ring/50 + border-ring | `ring-3 ring-ring/50` | `:focus-visible` only |

**Listed exceptions (deliberate):**
- **E1 Font stack.** The app uses Nunito Variable (headings) and Geist Variable (body) from bundled
  files. The mockup has zero external requests, so it uses `ui-rounded, system-ui, sans-serif` and
  `system-ui, sans-serif`. Mono stays `ui-monospace, SFMono-Regular, Menlo, monospace` (in scale).
- **E2 Telegram frame.** The digest mock copies the Telegram chat bubble (#effdde light / #2b5278 dark,
  radius 12px). It is not board UI and has no repo token.
- **E3 Mockup chrome.** The header strip, frame labels and callout badges belong to the mockup only.
  They use scale tokens, but their layout is outside the product.

## 2. Page-type vocabulary (answers §15 "labelled for a non-slug user")

| Slug (stored heading) | Human label (badge) | Path it covers |
|---|---|---|
| `linkedin__jobs-search` | **Jobs search** | `/jobs/search/…`, `/jobs/collections/…` |
| `linkedin__jobs-search-results` | **Search results** | `/jobs/search-results/…` |

- The badge shows the human label. The slug appears in the badge's `title` and `aria-label` ("Page type:
  Search results (linkedin__jobs-search-results)"). The user wrote the config, so the slug is kept one
  hover away, not removed. ASSUMED (unattended).
- The labels copy the URL path the user can read in the address bar, which helps memorability. The label map
  lives next to R1's classifier, so there is a single source (product-ui/be to place it).

## 3. Screen S1 — Settings › Where jobs come from › Search URLs card

**Layout (top → bottom inside the card, `p-4 gap-4 rounded-xl bg-card`):**
1. Card title "Search URLs" (`text-base`). Helper line (`text-xs muted-foreground`): "Paste any
   LinkedIn jobs link — it's cleaned and filed automatically."
2. *(R13, conditional)* Misfile notice (see C6).
3. Row list, `gap-2`. Each row is a card (`rounded-lg border p-3 gap-1`):
   - Line 1, `flex gap-2`: **Search URL** input (flex-1) · **Label** input (`w-48`) · Remove (ghost icon ×).
   - Line 2, `flex gap-2 items-center`: page-type badge (outline) · row note (`text-xs`), both in an
     `aria-live="polite"` region.
   - Field error sits under the URL input (existing `FieldError`).
4. "Add another search URL" (outline button, left-aligned under the list).
5. The section's sticky **SaveBar** (existing): "Unsaved changes" · Discard · **Save changes**.

**Row sub-states** (one row can be in exactly one):

| Row state | Trigger | Badge | Row note / error |
|---|---|---|---|
| typing | focus in URL, not yet blurred | none | none (never validate mid-paste) |
| recognised, clean | blur/paste, R1 ok, URL unchanged | `Jobs search` / `Search results` | none |
| recognised, cleaned | blur/paste, R1 stripped params | label as above | muted: "Cleaned — removed currentJobId, origin, referralSearchId" (≤3 names, then "+N more") |
| duplicate | cleaned URL equals an earlier row's | label | attention-strong: "Same search as "Comcast SRE" after cleaning — merged on save." + link-button **Remove now** |
| refused | blur, R1 rejects | none | FieldError (destructive-strong): see copy C4 |
| misfiled (R13, stored) | on load, R1 slug ≠ stored heading | derived label | attention-strong: "Saved as Jobs search — will be re-filed as Search results." |

**Five states (card):**
- **Default:** 3 saved rows, each with its badge. There is no SaveBar because the form is clean.
- **Empty:** no rows. Muted text "No LinkedIn searches yet. Paste a link from a LinkedIn jobs search
  page to start." A single empty row is auto-added and focused, so the first paste is 0 clicks. ASSUMED (unattended).
- **Loading:** 2 skeleton rows (`bg-muted rounded-lg h-8`) plus a skeleton badge. Today's code renders `null`.
  Doherty applies (see C9).
- **Error:** load failed. Alert destructive: "Couldn't load search links." with a **Retry** button. Today this is also `null`.
- **Success:** after Save, the SaveBar success strip (`border-l-2 border-l-success bg-success/10`) reads "Saved 4 search
  links. Cleaned 1, merged 1 duplicate." Clause order: re-filed, cleaned, merged. Clauses with a zero count are dropped, and
  "Saved N search links." alone appears when nothing changed. The server's R3 report is authoritative, and the
  strip shows what the server says it changed.
- **Save-error sub-state (server R4 4xx):** SaveBar stays dirty. A ValidationSummary above it reads "1 problem to
  fix" and links "Zafin — not a LinkedIn jobs search link" to the row. Nothing is written. Save blocked
  client-side works the same way: clicking Save with a refused row opens the same ValidationSummary.

## 4. Screen S2 — Run detail › "Links that failed" panel (R11)

Placement: at the top of the run detail body, where `DiagnosisPanel` sits for failed runs, above the funnel.
The panel uses DiagnosisPanel's visual idiom (icon, one evidence line, actions) with a new kind `bad-links` and
an attention tint. It renders on a **passed** run when ≥1 link soft-failed under R6. ASSUMED (unattended).
- Title: "2 search links failed — the run continued"
- Evidence line: "A link that worked earlier today still loaded, so LinkedIn is fine — these links are
  the problem."
- List (`text-sm`, ≤5 visible, "+N more" disclosure): **label** · shortened URL (mono `text-xs`,
  middle-truncated, full URL in `title`) · reason (muted), e.g. "results list never loaded".
- Actions: primary **Fix in Settings** → `#/settings/where-jobs-come-from`. Secondary **Copy links**.

Five states:
- **Default:** as above.
- **Empty:** no soft-failed links, so the panel is absent. Run detail is unchanged.
- **Loading:** the run detail's existing skeleton. No panel skeleton, because the panel waits on the same fetch.
- **Error:** the run detail's existing load-error. There is no panel-specific error.
- **Success:** the user fixes the links. The next run's detail has no panel (empty state), which is the success signal.
- **Contrast frame (unchanged, shown for reference):** a real outage, where the canary also failed, keeps today's red
  `total-outage` DiagnosisPanel. It is drawn so the reviewer can see the two stay distinct.

## 5. Screen S3 — Telegram digest (R11)

The existing `formatDigest` layout gets one new block, placed after Funnel and only when ≥1 link soft-failed:

```
✅ Job Bunny — harish (2026-09-30 14:00)
────────────────
Funnel: …
⚠️ 2 search links failed — LinkedIn is fine (an earlier link still loads):
  • Comcast SRE — results list never loaded
  • Zafin — results list never loaded
Fix: board → Settings → Where jobs come from
```

- The block names links by **label**, not URL, which suits a phone. Up to 5 are listed, then "+N more".
- States: the passed-with-bad-links digest (new), the passed clean digest (unchanged, no block), and the
  total-outage digest (unchanged 🔴). Loading and empty don't apply to a push message.

## 6. Interaction behaviours

- **Classify on blur or paste, error on blur only.** A paste event is a finished input, so the badge can
  appear on paste. The refused error waits for blur or Save. Typing never shows an error.
- **Blur rewrites the input to the cleaned URL.** The note says what was removed. There is no undo for cleaning,
  because the cleaned form is the only form stored (spec Q&A 2). Discard in the SaveBar reverts all unsaved edits.
- **Duplicate:** merged on save (R10). The first row's label wins. **Remove now** removes the row immediately
  and can be undone with Discard.
- **R13 Re-file:** one click normalises and saves through the same save path (R3). While saving, the button shows
  "Re-filing…" and is disabled. The success strip then reads "Re-filed 2 links." There is no undo, because the old state was broken.
- **Keyboard path:** URL → Label → Remove → next row … → Add another → SaveBar Discard → Save. The notice's
  Re-file button comes first in the card's tab order. Enter in an input does not submit. Esc does nothing
  new. Focus uses `ring-3 ring-ring/50` on `:focus-visible`.
- **A11y:** the badge has `aria-label` with the slug. The row note sits in `aria-live="polite"`. The refused error
  is `aria-describedby` on the URL input plus `aria-invalid`. Status is never colour alone: every note carries text.
- **No dead ends:** every refused state names a fix. Every failure surface (digest, run detail) links to the
  Settings card.

## 7. Efficiency pass

| Flow | Before (today) | After | Cut |
|---|---|---|---|
| Add one link | Add → paste → label → Save = 2 clicks + 2 inputs. Silently misfiled 1 of 2 page types, and fixing it needs the CLI (+ terminal round trip). | Add → paste → label → Save = 2 clicks + 2 inputs, always correct | CLI round trip, hand-cleaning |
| First link, empty card | Add → paste → label → Save | paste → label → Save (row auto-added and focused) | 1 click |
| Fix legacy misfiles | edit the raw config or the CLI | 1 click (Re-file) | the whole detour |
| Bad link to fix | 🔴 "outage" page → logs → guess | digest names the link → **Fix in Settings** (1 tap) → Remove → Save | log dig |

Killed (Occam): a "cleaned URL" diff view, a per-row "why this type?" tooltip, a success toast per row, and a
page-type eyebrow label. The badge alone does the job.

## 8. Numbered callouts

- **C1 — Human page-type label in the badge.** *Jakob / memorability:* the words copy the URL path the user
  sees. The slug is kept in title/aria for the developer.
- **C2 — Classify on blur/paste, never mid-type.** Following Baymard, inline validation during paste breaks the flow.
  Positive feedback (the badge) is the confirmation.
- **C3 — No page-type picker and no eyebrow.** *Hick's Law + spec §14:* zero choices. The badge is output, not
  input, so it is styled `outline`, not as a control.
- **C4 — Refused copy names the fix.** "This isn't a LinkedIn jobs search link. Paste one from
  linkedin.com/jobs/search, /jobs/search-results or /jobs/collections." It sits inline under the field, in
  destructive-strong. In ValidationSummary it is prefixed with the row label. It replaces the old host error and
  keeps the protocol error.
- **C5 — "Cleaned" is muted, not a warning.** *Occam / low noise (§15):* cleaning is good news. It uses
  muted-foreground text-xs, names ≤3 params, and disappears after save.
- **C6 — R13 as one card notice plus one button.** Attention strip at the top of the card (`border-l-2
  border-l-attention bg-attention/10 p-4`): "2 links are filed under the wrong page type, so runs read
  them with the wrong page reader." Button **Re-file 2 links**. *Von Restorff:* while the form is clean,
  this is the card's one distinct action. See the R13 verdict in §9.
- **C7 — Duplicate warned before save, merged on save.** *Error prevention:* the user sees the collapse before it
  happens. **Remove now** gives control. The label conflict is resolved by the system (Tesler).
- **C8 — Save success reports what the system changed.** Honest feedback for a silent rewrite, taken from the server's R3 report.
- **C9 — Skeleton on load, "Re-filing…" on click.** *Doherty:* today the card renders `null` while loading. A
  blank card reads as "no links".
- **C10 — Bad-links panel reuses the DiagnosisPanel idiom with an attention tint.** *Jakob (internal):* the operator
  already reads that panel. Attention is not destructive, because the run passed. The red outage stays visually distinct.
- **C11 — Digest names links by label and ends with "Fix:".** The digest is read on a phone, first
  (persona). Alert quality is load-bearing, so the digest names the cause, never "outage".
- **C12 — Empty card auto-adds a focused row.** *Fitts / efficiency:* the first paste goes straight into the field.

## 9. R13 — does it earn its space?

**Verdict: yes, but only in its C6 form (one conditional notice), never as a permanent column or per-row control.**
- **Against:** once R3 normalises every save and R8 repairs `harish`, new misfiles can't be created. R13
  fires on residual data only: other profiles' pre-existing rows, and anything written before ship.
- **For:** it costs zero pixels when there is nothing to report. The misfile badge in each row is the same badge as
  normal. The one-click fix makes the success metric "zero misfiled links across all profiles" reachable
  without a CLI. Product-ui may cut it (it is Could) without affecting any other screen.

## 10. Copy parity (non-board save paths — text only)

- CLI `config set` / `lane add-url` refused: `refused: <url> — not a LinkedIn jobs search link (expected
  /jobs/search, /jobs/search-results or /jobs/collections/…). Nothing written.`
- CLI changes report: one line per change, `re-filed <label>: Jobs search → Search results`, `cleaned
  <label>: removed currentJobId, origin`, `merged <label> into <label>`.
- API 4xx body message: same text as the CLI refused line. The board surfaces it via the ValidationSummary.

## 11. data-qa map (stable ids for the mockup and for pairing with shipped UI)

`search-urls-card`, `search-urls-helper`, `search-urls-misfile-notice`, `search-urls-refile-button`,
`search-url-row` (repeat, suffix `-<n>` in mockup), `search-url-input`, `search-url-label-input`,
`search-url-remove`, `search-url-page-type-badge`, `search-url-row-note`, `search-url-error`,
`search-url-duplicate-remove`, `search-urls-add`, `search-urls-empty`, `search-urls-skeleton`,
`search-urls-load-error`, `settings-savebar`, `settings-save-success`, `settings-validation-summary`,
`run-bad-links-panel`, `run-bad-links-list`, `run-bad-links-fix`, `run-bad-links-copy`,
`run-outage-panel`, `digest-bad-links-block`.
In the mockup, repeated rows get unique ids `search-url-row-1..n`. Children of repeated rows use the
same `-<n>` suffix, so every id is unique in the file.

## 12. ASSUMED (unattended) log

1. The badge shows a human label with the slug in title/aria (§2).
2. The empty card auto-adds a focused row (C12).
3. Blur rewrites the input to the cleaned URL. Cleaning has no per-row undo (Discard covers it).
4. On a duplicate, the first row's label wins.
5. R13 ships as a card notice plus a one-click Re-file that saves immediately (C6).
6. The run-detail bad-links panel shows on passed runs, as a new DiagnosisPanel kind `bad-links` (§4).
7. The run status stays "passed". There is no new runs-list marker, because the digest is the alert surface.
8. The digest names links by label, up to 5 of them.
9. Loading and error states for the card replace today's `null` renders.

## 13. Pillar scorecard

| Pillar | Score (1-5) | Rationale |
|---|---|---|
| Learnability | 5 | Zero new controls. Paste works, and the badge explains itself in address-bar words. |
| Efficiency | 4 | Add-link clicks are unchanged at their minimum. The Label input stays a required typed input even though the URL's `keywords` could prefill it. This was deliberately not designed in (see NOTES), which costs one input per add. |
| Memorability | 4 | Labels map to URL paths. But "Jobs search" also covers `/jobs/collections/…`, so the label is imperfect for collection links. |
| Error prevention | 4 | Refusal on blur, duplicate warning before merge, misfile notice. **Weakness:** the cleaned rewrite has no per-row undo. A user who wanted a stripped param (e.g. `start`) learns only from the note, and cannot keep it. This is correct by spec, but it is a loss of control. |
| Satisfaction | 4 | "It just works" is met. The bad-link panel turns a scary outage into a named fix. But the operator still learns about a bad link only after a run has spent a slot on it (live preview is out of scope). |
