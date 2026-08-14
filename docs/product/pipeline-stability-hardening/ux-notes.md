# UX Dossier — Pipeline Stability Hardening

Slug: `pipeline-stability-hardening` · Author: product-ux, 2026-08-13
Spec: `docs/product/pipeline-stability-hardening/spec.md` (frozen, 27 requirements / 21 ACs)
Persona: P1 "The Operator-Owner" — `docs/product/personas.md` v1.2
Mockup: `mockup.html`

---

## 0. Framing — where this feature actually lives

Per persona v1.2 (Q2b), **Telegram is the primary surface and the board is the drill-down.** So
this dossier designs **six message shapes first** and four board surfaces second. Message design is
part of the UX, not copy to be written later.

**Hard constraint found first-hand:** `TelegramNotifier.send()` posts `sendMessage` with **no
`parse_mode`** (`src/adapters/notify/telegram/telegram.ts:46-51`). There is **no bold, no italic, no
markdown, no HTML** available. All hierarchy must come from: leading emoji, the existing
`────────────────` separator, line grouping, two-space indentation, and UPPERCASE. Every message
below respects that. Adding `parse_mode` is a backend decision I have deliberately not assumed.

**Second constraint, self-derived:** the board is on `127.0.0.1:1994`. A phone cannot reach it. So a
Telegram message can carry **no useful deep link** — which means **every message must be terminal**:
complete enough that opening the board is optional, not a teaser that requires it. This is the
single strongest driver of the message copy below.

**Existing digest shape (reused, not reinvented)** — `src/ops/observability/report/digest.ts:38-59`:
banner `<icon> Job Bunny — <profile> (<date> <time>)`, separator, optional `Failed at stage: x`,
blank line, `Funnel:`, indented `  • <stage>: <in> → <out>`. Jakob's Law: the operator has read
this shape hundreds of times. Every new message is a **variation on it**, never a new format.

### Icon vocabulary (new — the cross-surface spine of this feature)

| Icon | Means | Board equivalent | Is it a failure? |
|---|---|---|---|
| ✅ | Run passed | `CircleCheck` / `text-success-strong` | No |
| 🔴 | Run failed | `TriangleAlert` / `text-destructive` | Yes |
| 🔴 + `NEW FAILURE` | A *second, different* failure | n/a (message-only) | Yes |
| ⏸️ | Slots deferred — system declined to start | `CirclePause` / `text-muted-foreground` | **No** |
| ⚠️ | Daemon degraded — scheduler is down | `CircleAlert` / `text-attention-strong` | Not a run |

Three meanings, three icons, one board colour each. ⏸️ is deliberately **not** in the red family and
**not** in the green family — it is the only chroma-free state, which is the whole of answer U1.

---

## 1. U1 — Does a `deferred` row read as a third failure state?

**Answer: it does, if you give it a status badge. So it does not get one — it is a different
*species* of row, not a different colour of the same row.**

I did not invent this treatment. `ui/src/features/runs/RunsList.tsx:34-90` already carries a
code-commented design law from the previous dossier: **"weight-not-hue"** — only the urgent three
(`degraded`/`failed`/`crashed`) plus `running` get a `border-l-*` accent; `produced`/`empty` are
plain bordered cards; and `unrecorded` gets **a dashed outline, no left accent at all**. The repo
already has a visual species meaning *"this row is not a run outcome."* `deferred` joins **that**
family, not the status-badge family.

Five moves, in order of how much each contributes:

1. **Grouping is the biggest win, not colour.** Five separate deferred rows still scan as five bad
   things (Miller). The five entries are wrapped in **one bordered group** with a single header —
   `5 slots deferred · host asleep` — and the five slot lines render **inside** it, indented and
   always present. One visual unit, one reason, one glance. AC19 is satisfied literally: five
   entries are on screen, each carrying its reason text, and zero rows read `failed`.
2. **Chroma-free, per the existing rule.** Dashed 1px `border-border`, `bg-card`, `CirclePause` in
   `text-muted-foreground`. No red, no amber, no left accent.
3. **Calm by fewer elements, never by fainter text.** `RunsList.tsx:92-98` states this rule
   explicitly ("the calm-zero contrast rule is *fewer elements, never fainter text*"). So the
   deferred entries drop the number slot, the funnel subline and the duration — but the reason text
   itself stays at normal `text-foreground` weight. My first instinct was to grey the whole row;
   the repo's own principle says that is wrong, and it is right.
4. **Copy in the active, protective voice.** Not *"did not run"* (absence — invites "where did my
   day go?"). Instead **"Deferred — host asleep"** with the supporting line **"Job Bunny declined to
   start these runs because the host was asleep."** The row states what the system *did*, and what
   it did was protect the day.
5. **Von Restorff, inverted.** On a lid-closed day the one visually distinct element must **not** be
   the deferrals. It is the **catch-up run that succeeded** — a normal `produced` row, green check,
   real number. The eye lands on "here is the run that covered your day," and the deferred group
   reads as the footnote explaining the gaps. That inversion is the emotional win.

**Two consequences I am ruling on as UX, because nobody else owns them:**

- **Deferred entries are never counted as failures anywhere** — not in a nav badge, not in the
  Mascot state, not in any "N failed" summary. A day of deferrals leaves the Mascot **asleep**
  (`fill-muted-foreground`, its existing daemon-idle state, `Mascot.tsx`), never alarmed.
- **A deferred entry is not clickable and opens no run detail.** It is not a run; there is no detail
  to show. Clicking would be a dead end (charter: user control). It expands **in place** instead.

---

## 2. U2 — Expressing a catch-up run that interrupts a machine in use

**Answer: the felt symptom is Chrome opening and the laptop getting busy — not a board row. So the
design's job is to make the *machine's behaviour* legible within one glance, and to do it where the
operator already is.**

1. **Name the visible artifact, not the abstraction.** The banner's supporting line is
   **"Chrome is open because Job Bunny is catching up on today's missed slots."** Recognition, not
   deduction. Jakob's Law: this is exactly how macOS explains background activity.
2. **State what it stands in for, up front** (R10/AC11): *"Catch-up run — standing in for 3 missed
   slots (14:00, 16:30, 19:00)."*
3. **Answer JTBD-2's actual question: how much longer.** The banner extends the existing
   `LiveRunHeader` (`ui/src/features/runs/LiveRunHeader.tsx:80-95`), which already renders stage
   progress off `run.progress` and elapsed time. It gains an **ETA** (`~19 min left`). If a
   duration estimate is not available, it degrades to elapsed-only — never a fake ETA.
4. **The Telegram side of the interruption is already solved by message T4**, which fires at wake and
   says *"Catch-up run starting now — digest to follow."* So the operator is told **before** the
   28-minute scrape surprises them, on the channel they actually read. There is no separate start
   ping; the deferral summary carries the start notice. That is why T4 and T5 are two messages and
   not one: T4 acknowledges immediately, T5 reports the result (Doherty, at human scale).
5. **No modal, no blocking toast.** The persona is mid-something. An interruption *about* an
   interruption is strictly worse. Inline banner only.
6. **The board never auto-opens.** Explicitly out.

### R11 dependency — stated plainly

R11 (stop the catch-up from the board) is a **Should**, because scheduled slots are spawned directly
by the daemon and do **not** route through the cancellable `run_intents` path. I have therefore
designed **two variants of the same banner**, both in the mockup as toggleable states:

| Variant | When | What the banner carries |
|---|---|---|
| **2a — stoppable** (`catchup-banner-stop`) | R11 delivered | Secondary `Stop catch-up` button, right-aligned. Confirms inline ("Stop it? This slot won't be retried today") — one attempt per day means stopping forfeits the day (R8b), which the operator must be told *before* clicking, not after. |
| **2b — not stoppable** (`catchup-banner-stop-unavailable`) | R11 cut | No button. Banner instead carries the ETA more prominently plus **"Runs to completion — about 19 min left."** Honest dead-end avoidance: we say it cannot be stopped rather than offering a control that does nothing. |

**Only variant 2a depends on R11.** Everything else in U2 — the label, the stand-in count, the
Chrome sentence, the ETA, message T4 — is Must-only and ships either way. If R11 is cut, this design
loses a button and nothing else.

---

## 3. Design Scale — the effective scale, recon'd

Job Bunny declares fonts, radii, colour and easing in `ui/src/index.css`, and declares **no spacing
tokens** — because spacing is **Tailwind v4's undeclared 4px grid**. That grid *is* the scale. Every
value in `mockup.html` comes from this table; exceptions are listed in §9.

**Spacing** — Tailwind default grid, `n × 4px`. Effective steps in actual use:

| Utility | Literal | Seen at |
|---|---|---|
| `gap-1` / `py-1` | 4px | `RunsList.tsx:211`, `input.tsx:11` |
| `gap-1.5` | 6px | `button.tsx:25` |
| `p-2` / `gap-2` / `py-2` / `size-2` | 8px | `RunsList.tsx:211,216` |
| `px-2.5` | 10px | `button.tsx:25` |
| `p-3` / `px-3` / `py-3` / `gap-3` | 12px | `RunsList.tsx:211`, `LiveRunHeader.tsx:83` |
| `p-4` / `px-4` / `gap-4` / `size-4` | 16px | `LiveRunHeader.tsx:83`, `RunsList.tsx:222` |
| `size-3.5` | 14px | `LiveRunHeader.tsx:108` |

**Type ramp** — Tailwind defaults; fonts declared `index.css:10-13`:

| Utility | Literal | Weight paired | Seen at |
|---|---|---|---|
| `text-xs` | 12px / 16px | 400 | `RunsList.tsx:244` |
| `text-sm` | 14px / 20px | `font-medium` 500 | `RunsList.tsx:228,238` |
| `text-base` | 16px / 24px | 400 | `input.tsx:11` |
| `text-2xl` | 24px / 32px | `font-heading` | `RunsList.tsx:234` |
| `font-sans` | Geist Variable | body default | `index.css:12` |
| `font-heading` / `font-display` | Nunito Variable | number slot, titles | `index.css:10-11` |
| `font-mono` | ui-monospace / SFMono / Menlo | remedy commands | `index.css:13` |

**Radii + borders** — `--radius: 1rem` (16px), `index.css:53-59,97`. Recon initially reported
`rounded-xl` as 16px; reading `index.css:56` myself shows it is `calc(--radius × 1.4)` = **22.4px**.
Corrected here.

| Token | Literal | Source |
|---|---|---|
| `rounded-sm` | 9.6px | `calc(--radius * 0.6)` |
| `rounded-md` | 12.8px | `calc(--radius * 0.8)` |
| `rounded-lg` | **16px** | `var(--radius)` — the row/card default |
| `rounded-xl` | 22.4px | `calc(--radius * 1.4)` |
| `rounded-2xl` / `3xl` / `4xl` | 28.8 / 35.2 / 41.6px | `calc(--radius * 1.8 / 2.2 / 2.6)` |
| `border` | 1px | Tailwind default |
| `border-l-2` | 2px | used by `degraded` / `running` |
| `border-l-[3px]` | 3px | existing in-repo arbitrary value, `failed` / `crashed` |

**Colour** — declared `index.css:64-149`, light / dark:

| Token | Light | Dark | Class | Role here |
|---|---|---|---|---|
| `--background` | `#faf8fd` | `#1a1523` | `bg-background` | page |
| `--foreground` | `#3d2c55` | `#e6ddf5` | `text-foreground` | body text |
| `--card` | `#ffffff` | `#241d30` | `bg-card` | every row |
| `--muted` | `#f1ecf8` | `#2e2540` | `bg-muted` | banner ground (`bg-muted/30`) |
| `--muted-foreground` | `#6e5b87` | `#a695c2` | `text-muted-foreground` | **deferred icon + meta** |
| `--border` | `#e4dbf0` | `#362c4a` | `border-border` | **deferred dashed outline** |
| `--primary` | `#7b5ea7` | `#b79ce0` | `bg-primary` | running dot, catch-up accent |
| `--accent` | `#efe8fa` | `#342a47` | `bg-accent` | row selected |
| `--destructive` | `#d64545` | `#f08a8a` | `text-destructive` | failed / crashed only |
| `--attention` | `#ff8a3d` | `#ff9e5e` | `bg-attention` | **daemon degraded** |
| `--attention-strong` | `#a04a06` | `#ff9e5e` | `text-attention-strong` | degraded text |
| `--success` | `#4caf6e` | `#6fcb8e` | `bg-success` | passed |
| `--success-strong` | `#26703f` | `#6fcb8e` | `text-success-strong` | passed icon |
| `--amber` | `#c98a2e` | `#e1a856` | `text-amber` | degraded run / stalled |
| `--ring` | `#7b5ea7` | `#b79ce0` | `ring-ring` | focus ring |

**Motion** — `--ease-hop: cubic-bezier(0.34,1.56,0.64,1)`, `--duration-hop: 150ms`, `@utility hop`
(`index.css:60-61,163-167`). A global `prefers-reduced-motion` block already clamps everything to
1ms (`index.css:169-178`) — inherited, nothing new needed.

**Primitives available** (`ui/src/components/ui/`): accordion, badge, button, card, dialog, form,
input, popover, progress, select, separator, skeleton, switch, tabs, textarea.
**No new shadcn primitive is required.** The deferred group uses `accordion` (already installed,
commit `aad87fd`); the degraded banner uses `card` + `button`; the catch-up banner extends
`LiveRunHeader` with the existing `progress`. Nothing here needs `shadcn add`.

---

## 4. Telegram message shapes

All six render in the mockup as phone-framed plaintext blocks. Line lengths ≤ 60 chars for phone
wrapping.

### T1 — First failure of a signature (`tg-first-failure`) · R17
**Unchanged from today.** This is the Jakob anchor every other message varies from; changing it
would cost recognition for no requirement. Existing `formatDigest` output verbatim.

### T2 — Daily reminder while still failing (`tg-failure-reminder`) · R18
Same 🔴 banner (still failing, still red — a softer icon would understate it). The **first body
line**, before the funnel, is the whole design:

```
🔴 Job Bunny — harish (2026-08-12 19:43)
────────────────
STILL FAILING (x6) — no new problem.
Same failure since 2026-08-11 15:49.
This is the once-a-day reminder, not a new alert.
Failed at stage: farm
```

`This is the once-a-day reminder, not a new alert.` is the line that prevents the exact harm of the
incident — six pages read as six events. UPPERCASE `STILL FAILING` is the only emphasis plaintext
allows.

### T3 — Different signature while another is suppressed (`tg-new-signature`) · R19 / AC17
The hardest one. It must break through **and** be unmistakable for T2. Three separators of meaning:

```
🔴 NEW FAILURE — Job Bunny — harish (2026-08-13 09:14)
────────────────
This is a DIFFERENT failure from the one already reported.

  NOW:        stage "source" — HTTP 429 from greenhouse
  STILL OPEN: stage "farm" — stalled: no beat()
              (x6, since 2026-08-11 15:49)
```

- Banner prefix `NEW FAILURE` — the strongest signal plaintext has, and absent from every other shape.
- The literal sentence `This is a DIFFERENT failure` — no inference required.
- Two labelled chunks, `NOW:` / `STILL OPEN:` (Miller). Carrying the suppressed failure forward is
  deliberate: without it the operator would think the first one resolved.

### T4 — Deferred-day summary (`tg-deferred-day`) · R21, the target experience
Fires **once**, at the first opportunity after the day's last slot has passed its grace window — in
practice on wake. Not 🔴.

```
⏸️ Job Bunny — harish (2026-08-12)
────────────────
Today's runs were deferred. Nothing failed.

Job Bunny declined to start 5 runs because the host
was asleep and could not reach the network.

  • 09:00 — deferred (host asleep)
  • 11:30 — deferred (host asleep)
  • 14:00 — deferred (host asleep)
  • 16:30 — deferred (host asleep)
  • 19:00 — deferred (host asleep)

No job data was scraped today.
Catch-up run starting now — digest to follow.
```

Line 1 of the body does the entire emotional job: **"Nothing failed."** Line 2 answers the incident's
actual question — *is it me, my laptop, or a bad merge?* — in one sentence, on the phone, with no
board and no terminal. **Variant `tg-deferred-day-no-catchup`** replaces the last line with
`Next scheduled slot: tomorrow 09:00.` for when no catch-up will fire.

**Incident-day message count under this design: 2 (T4 + T5). Today: 6.**

### T5 — Catch-up run digest (`tg-catchup-digest`) · R10 / AC11
Standard ✅/🔴 digest plus one label line immediately after the separator, before the funnel:

```
✅ Job Bunny — harish (2026-08-12 20:40)
────────────────
CATCH-UP RUN — stood in for 5 missed slots.
(09:00, 11:30, 14:00, 16:30, 19:00)

Funnel:
  • reconcile: 0 → 0
  ...
```

### T6 — Daemon degraded (`tg-daemon-degraded`) · R13 / R14
`kind: 'alert'` — text used verbatim, not a digest. Cause **and** remedy (Tesler: the operator should
not have to derive the fix):

```
⚠️ Job Bunny — daemon degraded

The scheduler has STOPPED starting runs.

Cause: the database schema (v7) is newer than the
running daemon's build (v6). This happens after an
update that changes the schema.

Fix: restart the daemon —
  jobbunny serve stop
  jobbunny serve start

No scheduled runs will start until you do.
```

Sent **once** (R13). The closing line is the consequence statement — without it the operator may
file it as noise and lose another two hours.

---

## 5. Board screens

Layout is unchanged: sidebar (`Triage / Tracker / Runs / Analytics / Setup & Health / Settings`),
runs list left column (`overflow-y-auto border-r`), detail right. **No new page is introduced.**
All four surfaces are reshapes of existing ones.

### S1 — Runs page, deferred day (`runs-page`) — the target picture
Top to bottom in the left column:

1. Existing header (`border-b p-3`): "Runs" + freshness chip + Refresh.
2. **Day reassurance line** (`runs-day-reassurance`) — new, `text-xs text-muted-foreground`,
   directly under the header: `2026-08-12 · 1 run, 5 slots deferred, 0 failed`. The `0 failed` is
   load-bearing: explicit negation of the feared thing.
3. **The catch-up run row** (`run-row-catchup`) — a normal `produced` row (`CircleCheck`,
   `text-success-strong`, `border border-border`, number slot `47`, `text-2xl font-heading`), plus a
   `badge` reading `Catch-up` and a subline `Stood in for 5 slots`. **This is the one visually
   distinct element on the screen** (Von Restorff).
4. **The deferred group** (`deferred-group`) — one `rounded-lg bg-card` container,
   `border border-dashed border-border`, `px-3 py-2 gap-1`:
   - Header row (`deferred-group-header`): `CirclePause` `size-4 text-muted-foreground` +
     `5 slots deferred` (`text-sm font-medium`) + reason `host asleep` (`text-sm`), number slot `—`.
   - Supporting line (`deferred-group-reason`, `text-xs text-muted-foreground`):
     `Job Bunny declined to start these runs because the host was asleep.`
   - Five entries (`deferred-slot-entry` ×5), indented `pl-4`, `text-xs`, each
     `09:00 · host asleep` — time (`deferred-slot-time`) + reason (`deferred-slot-reason`).
     **Always rendered**, so AC19's five-entries-with-reason assertion holds on first paint.
   - `deferred-group-toggle` collapses the five entries to the header alone. Collapse is an
     affordance, never the default.
5. Older runs below, unchanged.

### S2 — Runs page, catch-up in progress (`catchup-banner`)
Extends `LiveRunHeader` (`flex flex-col gap-2 border-b border-border bg-muted/30 px-4 py-3`):

- Line 1 (`catchup-banner-label`, `text-sm font-medium`): `Catch-up run — farm 2/10` + elapsed right.
- Line 2 (`catchup-banner-standin`, `text-xs text-muted-foreground`):
  `Standing in for 3 missed slots (14:00, 16:30, 19:00)`.
- `Progress` bar (`catchup-banner-progress`) — existing primitive.
- Line 3 (`catchup-banner-why`, `text-xs text-muted-foreground`):
  `Chrome is open because Job Bunny is catching up on today's missed slots.`
- Line 4: liveness dot (existing) + `catchup-banner-eta` `~19 min left`.
- Right: `catchup-banner-stop` (variant 2a) **or** `catchup-banner-stop-unavailable` (variant 2b).

### S3 — Run detail, catch-up run (`run-detail-catchup`)
Existing detail view plus, in the outcome header: `run-detail-catchup-badge` (`Catch-up`) and
`run-detail-covered-slots` — a `text-xs text-muted-foreground` list of the slot times it covered.
Answers "what did this actually replace?" without leaving the page.

### S4 — Daemon degraded (`daemon-degraded-banner`)
Two placements, because the operator may arrive from either direction:

- **Global strip** at the top of the shell, `bg-attention/10 border-b border-attention`,
  `CircleAlert text-attention-strong`. Persistent, dismissible-per-session only. It is the only
  amber thing on screen. Contains `daemon-degraded-cause`, `daemon-degraded-remedy`,
  `daemon-degraded-command` (`font-mono text-xs bg-muted/50 px-3 py-2`, mirroring
  `Step6Launch.tsx:91-113`'s existing command-hint treatment) and `daemon-degraded-copy-button`.
- **Settings → Schedule** (`schedule-daemon-status`): the section today shows only
  "Next run (saved): …". It gains an explicit daemon status line with four states —
  `-healthy` / `-degraded` / `-loading` / `-error`. Degraded shows the same cause + remedy.

The **Mascot** goes to its existing `asleep` state (`fill-muted-foreground`), not a new alarmed one —
the scheduler is not running, which is exactly what asleep already means. No new asset.

---

## 6. Five states per screen

| Screen | Default | Empty | Loading | Error | Success |
|---|---|---|---|---|---|
| Runs list | Mixed rows + deferred group | `runs-list-empty` — existing "No runs recorded yet" copy; deferred group simply absent | `runs-list-loading` — 3× `Skeleton h-12 w-full` (existing idiom), the group renders as one skeleton not five | `runs-list-error` — `text-destructive` + `Retry` secondary button (existing `ErrorRetry`) | Catch-up `produced` row, green check, real number |
| Deferred group | 5 entries expanded | Never empty by construction (R25: it exists only if ≥1 slot deferred) | Single `Skeleton h-12` — never five, or loading itself looks like an alarm | Reason text missing ⇒ render `reason unavailable` and flag; a blank reason is a defect per the spec's metric | Group present + a passing catch-up above it |
| Catch-up banner | Running, progress + ETA | n/a (only mounts while running) | `Catch-up run — starting…` (mirrors existing `Running — starting…`) | `WifiOff` + `Disconnected — last update Ns ago` + Retry (existing liveness path) | Banner unmounts; row appears as `produced` |
| Daemon status | Healthy: `Running · last tick 12s ago` | Never mounted (daemon absent ⇒ `Stopped`, existing) | `Skeleton h-8 w-40` (existing, `Step6Launch.tsx:305`) | `/api/daemon` unreachable ⇒ `Can't reach the daemon API` + Retry — kept distinct from `degraded` | Post-restart: returns to healthy, banner clears itself, no manual dismiss |

---

## 7. Efficiency pass — clicks and inputs

The lid-closed day, end to end:

| | Today | Designed |
|---|---|---|
| Notifications received | 6 identical | **2** (T4 + T5) |
| Actions to learn the cause | open board → runs → open a red row → read failure → still wrong → read `daemon.log` | **0 — the phone message says it** |
| Board clicks to confirm | 4+ | 1 (open Runs), optional |
| Terminal required | yes | no |

**Cut by this pass:**
- **A start-of-catch-up Telegram ping** — folded into T4's last line. Occam: a separate message
  earns nothing that a line earns.
- **A "recovered" notification** — already cut by the spec; success digests carry it.
- **A dedicated deferred-slot detail view** — nothing to show that the row does not already say.
  It would be a click into a dead end.
- **Per-reason icons** for deferred entries (moon / no-wifi) — one `CirclePause` for the kind, with
  the reason in text. Two icons would re-imply two severities.
- **A dismiss control on the degraded banner** — the condition is not dismissible; dismissing it
  re-creates the silent outage this feature exists to end. Session-scoped collapse only.

---

## 8. Numbered callouts (mirrored in the mockup's annotation panel)

1. **No status badge for deferred.** It joins the `unrecorded` dashed-outline species
   (`RunsList.tsx:85-89`), not the badge family. A fifth badge colour would read as a fifth way to
   fail. *(U1; Von Restorff)*
2. **Five entries, one group.** Grouping is what kills the "five alarms" scan; the five entries stay
   individually rendered so AC19 holds literally. *(Miller / chunking)*
3. **Reason text at full weight.** The repo's own rule — calm by *fewer elements, never fainter
   text* (`RunsList.tsx:92-98`). The reason is the payload; it must not be greyed.
4. **`—` in the number slot, never `0`.** Existing rule at `RunsList.tsx:108-111`: a literal `0`
   misreads as a zero-yield run. Deferred inherits it.
5. **Deferred rows are not clickable.** Not runs, no detail, no dead end. Expansion is in place.
   *(User control)*
6. **The catch-up row is the one distinct element.** On a lid-closed day the eye must land on what
   covered the day, not on what didn't run. *(Von Restorff, inverted — this changed the whole
   screen's hierarchy)*
7. **`NEW FAILURE` prefix + explicit contrast sentence.** Plaintext has no bold; UPPERCASE plus a
   literal "this is a DIFFERENT failure" is the only reliable break-through. *(R19/AC17; the
   constraint that `parse_mode` is unset directly forced this)*
8. **"This is the once-a-day reminder, not a new alert."** One line that prevents the incident's
   actual harm — N pages read as N events.
9. **T4 carries the catch-up start notice.** Removes a whole message while making the 28-minute
   interruption expected rather than surprising. *(Doherty, at human scale; U2)*
10. **Name Chrome, not the pipeline.** The operator's felt symptom is a browser window opening.
    *(Jakob's Law — this changed the banner copy from "catch-up in progress" to naming the artifact)*
11. **Stop confirms before acting.** One catch-up per day (R8b), so stopping forfeits the day. The
    operator must be told before the click, not after. *(Error prevention; variant 2a only)*
12. **Remedy is copyable, in `font-mono`.** Mirrors the existing command-hint treatment at
    `Step6Launch.tsx:91-113`. *(Tesler — the system carries the remedy, not the operator's memory)*
13. **Degraded ≠ unreachable.** `/api/daemon` failing is "we can't tell"; schema drift is "we know,
    and it's broken." Kept visually distinct, exactly as `LiveRunHeader` already separates
    `stalled` from `disconnected` (`LiveRunHeader.tsx:32-39`).
14. **Deferrals never count as failures** in badges, Mascot, or summaries. *(U1)*

---

## 9. Accessibility

- **Keyboard:** the deferred group is a single focusable disclosure (`accordion`), not five
  `role="option"` entries — it must not enter the runs listbox, or arrow-key navigation would step
  through non-runs. `Stop catch-up` and `Copy command` are ordinary buttons in DOM order.
- **Focus:** inherited global `outline-ring/50` (`index.css:151-154`). Nothing custom.
- **Contrast:** `--muted-foreground #6e5b87` on `--card #ffffff` ≈ **5.98:1** — passes AA for
  12px text. `--attention-strong #a04a06` on `bg-attention/10` passes AA. `--attention #ff8a3d`
  is **never** used for text, only for the banner border/ground.
- **Never colour alone:** every state carries icon + distinct label text + border treatment, so all
  five row species remain distinguishable in greyscale — the requirement the previous dossier
  already set (`runOutcome.ts:45-55`).
- **Labels:** `CirclePause` is `aria-hidden`; the row's text label is the accessible name. The
  degraded banner is `role="status"`, not `role="alert"` — it is persistent, and an assertive live
  region would re-announce on every poll.
- **Motion:** the global reduced-motion clamp already covers the progress bar and pulsing dot.

### Design Scale exceptions (deliberate, and the complete list)

| Value | Where | Why |
|---|---|---|
| `border-l-[3px]` (3px) | failed / crashed rows | Pre-existing in-repo arbitrary value (`RunsList.tsx:73`). Reproduced, not introduced. |
| `bg-destructive/8`, `bg-primary/5`, `bg-muted/30`, `bg-attention/10` | row grounds, banners | Opacity modifiers on scale colours, matching existing usage. Not new colours. |
| `bg-muted/50` | `daemon-degraded-command` | Mirrors the existing command-hint ground at `Step6Launch.tsx:91-113`. Opacity modifier on a scale colour. |
| Phone frame chrome in the mockup | Telegram screens only | Presentation scaffolding for the annotated mockup — not shipped UI, not a design token. |
| `rgba(--foreground, low α)` shadows | mockup phone frame + callout badges | Mockup-only depth cue derived from `--foreground`, not a new hex. Same technique as the sibling `run-experience-overhaul/mockup.html`. Not shipped UI. |

No spacing, type, or radius value outside §3 is used anywhere.

---

## 10. Charter scorecard

| Pillar | Score | Rationale |
|---|---|---|
| **Learnability** | 5/5 | Every message is a variation on the digest shape the operator already reads daily; the deferred row reuses an existing in-repo species (`unrecorded`). Almost nothing new to learn — the icon vocabulary is three symbols. |
| **Efficiency** | 5/5 | 6 notifications → 2; the cause moves from a log file to line 2 of a phone message; zero clicks to answer the incident's question. |
| **Memorability** | **3/5** | **The weakest pillar, and honestly so.** The ⏸️/🔴/⚠️ distinction has to survive months between sightings — a lid-closed day may occur once a quarter. The operator will plausibly re-read T4 from scratch each time. I mitigated with self-describing copy ("Nothing failed", "This is a DIFFERENT failure") rather than relying on icon recall, but a symbol seen four times a year is not memorised, and I am not going to claim otherwise. |
| **Error prevention** | 4/5 | The stop-confirm guards the one-attempt-per-day trap; degraded is undismissible; blank reason text renders visibly rather than silently. Not 5: **if the daemon is degraded it may be unable to send T6 at all** — the alert path may share the failure it is reporting. I flag this in §11 rather than pretending the design closes it. |
| **Satisfaction** | 4/5 | The target picture lands: one calm message, "Nothing failed", and a green catch-up row as the brightest thing on screen. Not 5, because the day's job data is still genuinely lost until the catch-up completes — good design makes that legible, it does not make it good news. |

**Named weakness:** memorability of the icon vocabulary across long gaps (3/5), plus the
degraded-daemon self-report dependency under Error prevention (4/5). Neither is fixable at the
design layer alone.

---

## 11. Open items and flags for downstream stages

1. **T6 may be unsendable by the component it describes.** If the daemon cannot open the DB, whether
   it can still reach the notifier is a backend question. If it cannot, the board banner (S4) becomes
   the *only* channel — and the spec's "≤ one tick + one notification" metric would not hold.
   **product-be must confirm the alert path does not depend on the degraded resource.** I have not
   designed around this silently.
2. **ETA source.** `catchup-banner-eta` assumes a duration estimate is derivable (historical run
   durations, or `run_progress`). If not, the banner ships elapsed-only — designed for, §6.
3. **R11 variant selection.** Variants 2a/2b are both mocked. product-be decides which ships; §2 states
   exactly what is lost if 2b.
4. **Spec observation, not a deviation:** R23 requires reason text, and the success metrics treat a
   blank reason as a defect — but no requirement says what the board renders *if* it is blank. I
   chose a visible `reason unavailable` over hiding the entry, because a silently-hidden deferral
   reintroduces "where did my day go?". Flagging rather than assuming.
5. **`data-testid` vs `data-qa`.** The repo already uses `data-testid` (`run-row`,
   `run-row-number`, `data-outcome-kind`). The mockup's `data-qa` ids are **additive** for
   downstream mapping and must not replace existing `data-testid` attributes in the implementation.
