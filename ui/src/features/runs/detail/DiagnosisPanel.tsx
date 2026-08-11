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
import { navigate } from '../../../lib/router';
import { cn } from '../../../lib/utils';
import type { DiagnosisAction } from '../diagnosisActions';
import { formatRetryIn } from '../diagnosisActions';
import type { DiagnosisKind, DiagnosisVerdict } from '../runDiagnosis';

export interface DiagnosisPanelProps {
  verdict: DiagnosisVerdict;
  /** The caller's run trigger — dispatched by a `kind: 'run'` action. */
  onRun: () => void;
  /** Reveals the Evidence section (`RunDetailView`'s `EvidenceSection`) —
   * dispatched by a `kind: 'reveal'` action, primary or secondary alike. */
  onReveal: () => void;
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
 * `fallback`; amber-tinted (B15's amber tokens) for the "something is off
 * but the run tells a specific story" classes (`stall`, `expired-login`,
 * `breaker-open`, and `degraded` — fix-round finding #2: a `'degraded'` run
 * is a `status: 'passed'` run that ran with warnings, never a failure, so it
 * gets the SAME amber register as the other non-fatal classes, never
 * destructive-red); calm muted-tint for `zero-yield-healthy` — deliberately
 * the same register as a healthy row, never alarming (C8).
 */
const KIND_ICON: Record<DiagnosisKind, LucideIcon> = {
  stall: Timer,
  'total-outage': OctagonAlert,
  'expired-login': LogIn,
  'zero-yield-healthy': CircleCheck,
  'breaker-open': Ban,
  'chrome-not-found': MonitorOff,
  degraded: CircleAlert,
  fallback: CircleAlert,
};

const KIND_TINT: Record<DiagnosisKind, { bg: string; fg: string }> = {
  stall: { bg: 'bg-amber/10', fg: 'text-amber' },
  'total-outage': { bg: 'bg-destructive/10', fg: 'text-destructive' },
  'expired-login': { bg: 'bg-amber/10', fg: 'text-amber' },
  'zero-yield-healthy': { bg: 'bg-muted', fg: 'text-muted-foreground' },
  'breaker-open': { bg: 'bg-amber/10', fg: 'text-amber' },
  'chrome-not-found': { bg: 'bg-destructive/10', fg: 'text-destructive' },
  degraded: { bg: 'bg-amber/10', fg: 'text-amber' },
  fallback: { bg: 'bg-destructive/10', fg: 'text-destructive' },
};

/**
 * Line-2 "evidence clause" copy, keyed by kind. `DiagnosisVerdict` carries no
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
  degraded: 'The run finished (status: passed), but recorded warnings worth a look.',
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
 * The mockup's `.countdown-chip` (amber tint, rounded-full, monospace,
 * tiny) — rendered only next to a disabled `kind: 'run'` action that
 * carries a `retryAt` `formatRetryIn` can still count down to. Never
 * invents a countdown: no `retryAt`, or an already-past one, means no chip.
 */
function RetryChip({ action }: { action: DiagnosisAction }) {
  if (action.kind !== 'run' || action.retryAt === undefined) return null;
  const text = formatRetryIn(action.retryAt, Date.now());
  if (text === null) return null;
  return (
    <span
      data-testid="diagnosis-retry-chip"
      className="rounded-full bg-amber/10 px-2 py-0.5 font-mono text-[10px] text-amber"
    >
      {text}
    </span>
  );
}

/**
 * Renders one `DiagnosisAction`, dispatching on `action.kind` — the one
 * place every action's real target (a run, a route, a clipboard copy, or an
 * Evidence reveal) becomes a real handler. `tone` picks the button variant:
 * `'primary'` is the shadcn `Button` idiom this codebase keys "primary" off
 * (`variant="default"`, which renders `data-variant="default"` on the DOM
 * element); `'quiet'` is a `variant="link"` control, used for every
 * secondary action and for the primary slot on the calm `'zero-yield-
 * healthy'` verdict (C8 — no alarming affordance on a healthy run).
 */
function ActionButton({
  action,
  tone,
  onRun,
  onReveal,
  testId,
}: {
  action: DiagnosisAction;
  tone: 'primary' | 'quiet';
  onRun: () => void;
  onReveal: () => void;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);
  const variant = tone === 'primary' ? 'default' : 'link';
  const className = tone === 'primary' ? undefined : 'h-auto self-start px-0';

  async function handleCopy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser sandbox — the
      // command still renders in the label, copyable by hand (same
      // swallow-on-denial idiom as RunNowButton's CopyServeStartButton).
    }
  }

  switch (action.kind) {
    case 'run':
      return (
        <Button
          type="button"
          data-testid={testId}
          variant={variant}
          size="sm"
          className={className}
          disabled={action.disabled}
          onClick={onRun}
        >
          {action.label}
        </Button>
      );
    case 'navigate':
      return (
        <Button
          type="button"
          data-testid={testId}
          variant={variant}
          size="sm"
          className={className}
          onClick={() => navigate(action.route)}
        >
          {action.label}
        </Button>
      );
    case 'copy':
      return (
        <Button
          type="button"
          data-testid={testId}
          variant={variant}
          size="sm"
          className={className}
          onClick={() => handleCopy(action.command)}
        >
          {copied ? 'Copied' : action.label}
        </Button>
      );
    case 'reveal':
      return (
        <Button
          type="button"
          data-testid={testId}
          variant={variant}
          size="sm"
          className={className}
          onClick={onReveal}
        >
          {action.label}
        </Button>
      );
  }
}

/**
 * B18 (plan.md), amended for the action-table rewrite — renders a
 * `DiagnosisVerdict` (runDiagnosis.ts, B14) per ux-notes §6's anatomy.
 * Present for failed/crashed/degraded/empty run outcomes; never rendered
 * for a clean produced run (that decision belongs to the caller,
 * `RunDetailView.tsx` — this component always renders something once
 * given a verdict, per §9's "never rendered empty").
 */
export function DiagnosisPanel({ verdict, onRun, onReveal }: DiagnosisPanelProps) {
  const primaryTone = verdict.kind === 'zero-yield-healthy' ? 'quiet' : 'primary';
  return (
    <div
      data-testid="diagnosis-panel"
      className="flex gap-3 rounded-lg border border-border bg-card p-3"
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
          <ActionButton
            action={verdict.action}
            tone={primaryTone}
            onRun={onRun}
            onReveal={onReveal}
            testId="diagnosis-action"
          />
          <RetryChip action={verdict.action} />
          {verdict.secondaryAction && (
            <ActionButton
              action={verdict.secondaryAction}
              tone="quiet"
              onRun={onRun}
              onReveal={onReveal}
              testId="diagnosis-secondary-action"
            />
          )}
        </div>
      </div>
    </div>
  );
}
