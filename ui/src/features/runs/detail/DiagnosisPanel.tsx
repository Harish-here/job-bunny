import {
  Ban,
  CircleAlert,
  CircleCheck,
  LogIn,
  type LucideIcon,
  MonitorOff,
  OctagonAlert,
  Timer,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import type { DiagnosisKind, DiagnosisVerdict } from '../runDiagnosis';

export interface DiagnosisPanelProps {
  verdict: DiagnosisVerdict;
}

/**
 * ux-notes.md §6's "Diagnosis panel anatomy": 32px tinted circle icon, line 1
 * = the one-sentence diagnosis (`verdict.title`), line 2 = the evidence
 * clause, then an action row with exactly one primary action plus at most
 * one quiet secondary — never a menu of remedies.
 *
 * Icon + tint mapping is this file's own judgment call (plan.md/ux-notes.md
 * name per-class icons only inconsistently, and `DiagnosisVerdict` carries no
 * icon field): destructive-tinted for the two whole-run failures with no
 * softer read (`total-outage`, `chrome-not-found`) and the unclassified
 * `fallback`; amber-tinted (B15's amber tokens) for the three "something is
 * off but the run tells a specific story" classes (`stall`, `expired-login`,
 * `breaker-open`); calm muted-tint for `zero-yield-healthy` — deliberately
 * the same register as a healthy row, never alarming (C8).
 */
const KIND_ICON: Record<DiagnosisKind, LucideIcon> = {
  stall: Timer,
  'total-outage': OctagonAlert,
  'expired-login': LogIn,
  'zero-yield-healthy': CircleCheck,
  'breaker-open': Ban,
  'chrome-not-found': MonitorOff,
  fallback: CircleAlert,
};

const KIND_TINT: Record<DiagnosisKind, { bg: string; fg: string }> = {
  stall: { bg: 'bg-amber/10', fg: 'text-amber' },
  'total-outage': { bg: 'bg-destructive/10', fg: 'text-destructive' },
  'expired-login': { bg: 'bg-amber/10', fg: 'text-amber' },
  'zero-yield-healthy': { bg: 'bg-muted', fg: 'text-muted-foreground' },
  'breaker-open': { bg: 'bg-amber/10', fg: 'text-amber' },
  'chrome-not-found': { bg: 'bg-destructive/10', fg: 'text-destructive' },
  fallback: { bg: 'bg-destructive/10', fg: 'text-destructive' },
};

/**
 * Line-2 "evidence clause" copy, keyed by kind. `DiagnosisVerdict` (Task
 * 11/B14) carries only `title`/`nextAction`/`rawError`/`lastCheckpoint` — no
 * field separate from `title` for ux-notes §6's Evidence column, and for
 * some classes (`zero-yield-healthy` notably) `title` already folds a
 * biggest-drop clause into one sentence. Rather than duplicating `title`
 * verbatim as line 2, this panel supplies its own short, class-accurate
 * description (a judgment call, documented here rather than inventing an
 * exact-numbers reproduction of ux-notes' illustrative copy, which needs
 * data — URL counts, breaker reopen time, paths tried — this verdict shape
 * doesn't carry). `fallback` has no entry: its evidence slot is the raw
 * error element instead (`FallbackEvidence`, below).
 */
const EVIDENCE_TEXT: Record<Exclude<DiagnosisKind, 'fallback'>, string> = {
  stall: 'The stage stopped reporting progress before finishing.',
  'total-outage': 'Every lane attempted in this stage failed — no partial result.',
  'expired-login': 'Every attempted LinkedIn search URL came back as an empty job shell.',
  'zero-yield-healthy':
    'The pipeline ran end to end; nothing scraped passed your filter.',
  'breaker-open':
    'Consecutive withheld job listings tripped the shared throttle breaker.',
  'chrome-not-found': 'None of the known per-OS Chrome install paths resolved.',
};

function DiagnosisIcon({ kind }: { kind: DiagnosisKind }) {
  const Icon = KIND_ICON[kind];
  const tint = KIND_TINT[kind];
  return (
    <div
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full',
        tint.bg,
      )}
    >
      <Icon className={cn('size-4', tint.fg)} aria-hidden="true" />
    </div>
  );
}

/**
 * ux-notes §6's fallback row: "raw error in a 2-line-clamped `<pre>`,
 * expandable; last checkpoint shown". The toggle is a plain `<button>` (no
 * `data-variant`) so it never competes with the panel's one primary action
 * in a "how many primary buttons" query.
 */
function FallbackEvidence({
  rawError,
  lastCheckpoint,
}: {
  rawError: string;
  lastCheckpoint: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <pre
        data-testid="diagnosis-raw-error"
        className={cn(
          'overflow-hidden rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-muted-foreground',
          !expanded && 'line-clamp-2',
        )}
      >
        {rawError}
      </pre>
      <button
        type="button"
        data-testid="diagnosis-raw-error-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="self-start text-xs text-primary underline-offset-4 hover:underline"
      >
        {expanded ? 'Show less' : 'Show full error'}
      </button>
      {lastCheckpoint !== undefined && (
        <p
          data-testid="diagnosis-last-checkpoint"
          className="text-xs text-muted-foreground"
        >
          Last checkpoint: <code className="font-mono">{lastCheckpoint}</code>
        </p>
      )}
    </div>
  );
}

/**
 * The action row. Every non-calm kind gets exactly one primary action
 * (`variant="default"`, the shadcn Button idiom this codebase already keys
 * "primary" off — see `data-variant` on `button.tsx`). `zero-yield-healthy`
 * (ux-notes' class iv) is the sole exception: C8's "no button on purpose" —
 * it renders only a quiet `variant="link"` secondary
 * ("Review filter rules →"), never a `variant="default"` button, so an
 * alarming affordance never appears on a healthy run.
 */
function ActionRow({ verdict }: { verdict: DiagnosisVerdict }) {
  if (verdict.kind === 'zero-yield-healthy') {
    return (
      <Button variant="link" size="sm" className="h-auto self-start px-0">
        {verdict.nextAction} →
      </Button>
    );
  }
  return (
    <Button variant="default" size="sm">
      {verdict.nextAction}
    </Button>
  );
}

/**
 * B18 (plan.md) — renders a `DiagnosisVerdict` (runDiagnosis.ts, B14) per
 * ux-notes §6's anatomy. Present for failed/crashed/degraded/empty run
 * outcomes; never rendered for a clean produced run (that decision belongs
 * to the caller, `RunDetailView.tsx` — this component always renders
 * something once given a verdict, per §9's "never rendered empty").
 */
export function DiagnosisPanel({ verdict }: DiagnosisPanelProps) {
  return (
    <div
      data-testid="diagnosis-panel"
      className="flex gap-3 rounded-lg border border-border bg-card p-4"
    >
      <DiagnosisIcon kind={verdict.kind} />
      <div className="flex flex-1 flex-col gap-1">
        <p data-testid="diagnosis-line-1" className="text-base font-medium">
          {verdict.title}
        </p>
        {verdict.kind === 'fallback' ? (
          <FallbackEvidence
            rawError={verdict.rawError ?? ''}
            lastCheckpoint={verdict.lastCheckpoint}
          />
        ) : (
          <p data-testid="diagnosis-line-2" className="text-sm text-muted-foreground">
            {EVIDENCE_TEXT[verdict.kind]}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <ActionRow verdict={verdict} />
        </div>
      </div>
    </div>
  );
}
