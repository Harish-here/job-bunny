import { CirclePause } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion';
import type { DeferredSlotRow } from '../../lib/api/types';

/** The single disclosure's item value — an accordion of type="single" only
 * ever has this one item, so the literal is never surfaced to callers
 * (mirrors `EvidenceSection.tsx`'s own `EVIDENCE_ITEM` convention). */
const DEFERRED_ITEM = 'deferred';

/** Short header word per `reasonCode` (spec.md's own literal examples,
 * "host asleep" / "network unreachable"; "daemon unavailable" follows the
 * same pattern). Branches off `reasonCode`, never `reason` text, per
 * `blueprint-be.md`'s "UI must key branching off reasonCode" note. */
const REASON_CODE_WORD: Record<DeferredSlotRow['reasonCode'], string> = {
  'host-asleep': 'host asleep',
  'network-unreachable': 'network unreachable',
  'daemon-unavailable': 'daemon unavailable',
};

/**
 * `deferred-group-reason`'s uniform-reasonCode sentence, one per
 * `reasonCode`. `host-asleep`'s text is the mockup's own literal copy
 * (blueprint.md §3 "resolved" note, mockup.html ~line 471). The other two
 * have no literal PLURAL copy anywhere in the dossier — only per-slot
 * singular sentences exist (`ops/daemon/gate/reachability_gate.ts`,
 * `ops/daemon/gate/deferred_sweep.ts`) — so this file pluralizes them the
 * same way the one given literal pluralizes host-asleep's singular source
 * ("this run"/"the host" -> "these runs"/"the host"); a judgment call
 * recorded here, not silently decided.
 */
const REASON_CODE_SENTENCE: Record<DeferredSlotRow['reasonCode'], string> = {
  'host-asleep': 'Job Bunny declined to start these runs because the host was asleep.',
  'network-unreachable':
    'Job Bunny declined to start these runs because the network was unreachable.',
  'daemon-unavailable':
    "Job Bunny's scheduler was not running during these scheduled windows.",
};

/** Mixed-`reasonCode`-day fallback (blueprint.md §3's own resolved literal
 * copy) — used both for the header's short reason word and the full
 * sentence below it. */
const MIXED_REASON_SENTENCE =
  'Job Bunny declined to start several runs today — see below for each reason.';

function reasonsAreUniform(
  rows: DeferredSlotRow[],
): DeferredSlotRow['reasonCode'] | null {
  const first = rows[0];
  if (!first) return null;
  return rows.every((r) => r.reasonCode === first.reasonCode) ? first.reasonCode : null;
}

function headerReasonWord(rows: DeferredSlotRow[]): string {
  const code = reasonsAreUniform(rows);
  return code ? REASON_CODE_WORD[code] : 'mixed reasons';
}

function groupReasonSentence(rows: DeferredSlotRow[]): string {
  const code = reasonsAreUniform(rows);
  return code ? REASON_CODE_SENTENCE[code] : MIXED_REASON_SENTENCE;
}

/**
 * D3b (blueprint.md step 1.3, R21-R25) — a always-open-by-default
 * disclosure listing a day's deferred scheduler slots. Pure presentational:
 * props are exactly `{ rows }`, no `date`/`loading`/`error` (the caller,
 * `RunsPage.tsx`, task 24, owns fetch state). Renders `null` for an empty
 * array (R25 "never empty by construction") — the caller is trusted never
 * to mount this with zero rows in the first place.
 *
 * Structure mirrors the mockup's own DOM (`docs/product/pipeline-stability-
 * hardening/mockup-fragment.html`, S1): the static header + reason sentence
 * sit OUTSIDE the collapsible region; only the five-or-fewer slot entries
 * live inside `AccordionContent`; the toggle (`AccordionTrigger`) is a
 * separate control positioned AFTER the entries, per the mockup's literal
 * `dg-toggle` placement — it does not wrap the header (§6 divergence 2).
 * The primitive's own chevron communicates expanded/collapsed state via
 * native `aria-expanded`, replacing the mockup's hand-rolled "Collapse"/
 * "Expand" text-swap (a deliberate, documented divergence).
 */
export function DeferredGroup({ rows }: { rows: DeferredSlotRow[] }) {
  if (rows.length === 0) return null;

  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={DEFERRED_ITEM}
      data-qa="deferred-group"
      data-testid="deferred-group"
      className="rounded-lg border border-dashed border-border bg-card px-3 py-2 gap-1"
    >
      <AccordionItem value={DEFERRED_ITEM}>
        <div
          data-qa="deferred-group-header"
          data-testid="deferred-group-header"
          className="flex flex-wrap items-baseline gap-2"
        >
          <CirclePause aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {rows.length} slot{rows.length === 1 ? '' : 's'} deferred
          </span>
          <span className="text-sm text-muted-foreground">{headerReasonWord(rows)}</span>
          <span className="ml-auto font-heading font-bold text-muted-foreground">—</span>
        </div>
        <p
          data-qa="deferred-group-reason"
          data-testid="deferred-group-reason"
          className="text-xs text-muted-foreground"
        >
          {groupReasonSentence(rows)}
        </p>
        <AccordionContent>
          {/* Each entry's reason is the SAME short `REASON_CODE_WORD` the
              header already renders (mockup.html ~475, ux-notes.md §5 S1
              item 4: "each `09:00 · host asleep`") — never `row.reason`'s
              full declined-to-start sentence. Rendering the long sentence
              per entry (BUG 4) stacked five near-identical paragraphs and
              recreated the "five alarms" scan the grouping exists to kill
              (ux-notes.md §5 callouts 2/3); `blueprint.md:117` prescribed
              the `reason` string, but the mockup and ux-notes win. */}
          <div className="flex flex-col gap-1">
            {rows.map((row, i) => {
              const n = i + 1;
              return (
                <div
                  key={`${row.runDate}-${row.slot}`}
                  data-qa={`deferred-slot-entry-${n}`}
                  data-testid={`deferred-slot-entry-${n}`}
                  className="pl-4 text-xs"
                >
                  <span
                    data-qa={`deferred-slot-time-${n}`}
                    data-testid={`deferred-slot-time-${n}`}
                  >
                    {row.slot}
                  </span>
                  <span> · </span>
                  <span
                    data-qa={`deferred-slot-reason-${n}`}
                    data-testid={`deferred-slot-reason-${n}`}
                    className="text-xs"
                  >
                    {REASON_CODE_WORD[row.reasonCode]}
                  </span>
                </div>
              );
            })}
          </div>
        </AccordionContent>
        <AccordionTrigger
          data-qa="deferred-group-toggle"
          data-testid="deferred-group-toggle"
          className="text-xs text-primary"
        >
          Details
        </AccordionTrigger>
      </AccordionItem>
    </Accordion>
  );
}
