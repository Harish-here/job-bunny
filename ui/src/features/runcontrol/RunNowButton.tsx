import { Play } from 'lucide-react';
import { useState } from 'react';
import { formatRelative } from '../../../../src/core/datetime/index.ts';
import { Button } from '../../components/ui/button';
import { navigate } from '../../lib/router';
import type { RunControlHandle } from './useRunControl';

const SERVE_START_COMMAND = 'jobbunny serve start';

interface SecondaryAction {
  label: string;
  onClick: () => void;
  hint?: string;
}

function secondaryFor(control: RunControlHandle): SecondaryAction[] {
  switch (control.state.kind) {
    case 'queued':
      return [{ label: 'Cancel', onClick: control.onCancel }];
    case 'daemon-down':
      // ux-notes §8: daemon-down is the one state with TWO secondary
      // controls side by side — 'Keep queued' is a deliberate no-op (the
      // intent is already queued; this just acknowledges the warning
      // without cancelling it, and the reversible-action rule in
      // ux-notes §10 rules out a confirm dialog on either).
      return [
        { label: 'Keep queued', onClick: () => {} },
        { label: 'Cancel', onClick: control.onCancel },
      ];
    case 'expired':
      return [
        {
          label: 'Queue again',
          onClick: control.onRun,
          hint: `Start the daemon with: ${SERVE_START_COMMAND}`,
        },
      ];
    case 'conflict':
    case 'failed':
      return [{ label: 'View run', onClick: () => navigate({ name: 'runs' }) }];
    default:
      return [];
  }
}

/** ux-notes §8's destructive/amber outline treatments — layered on top of
 * the `Button` component's own `outline` variant via `className`, since
 * neither tone is a variant `Button` defines. `null` for every other
 * state, which keeps the default `variant="default"` look untouched. */
function toneClassNameFor(kind: RunControlHandle['state']['kind']): string | null {
  switch (kind) {
    case 'daemon-down':
      return 'border-destructive text-destructive hover:bg-destructive/10';
    case 'daemon-unknown':
      return 'border-amber text-amber hover:bg-amber/10';
    default:
      return null;
  }
}

/** The `[Copy: jobbunny serve start]` affordance (ux-notes §8's daemon-down
 * state) — writes the literal command to the clipboard, with the same
 * transient "Copied" feedback and swallow-on-denial behavior already
 * established by the wizard's `DaemonStartHint` (Step6Launch.tsx). Kept
 * local rather than shared: the two components render in different
 * contexts (full-width step vs. sidebar block) and sharing would mean
 * exporting an internal across a feature boundary for one small handler. */
function CopyServeStartButton() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(SERVE_START_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser sandbox — the
      // command still renders in the label, copyable by hand.
    }
  }

  return (
    <Button
      type="button"
      data-testid="run-now-copy"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
    >
      {copied ? 'Copied' : `Copy: ${SERVE_START_COMMAND}`}
    </Button>
  );
}

/** The persistent last-run status line (C15/ux-notes §8): outcome dot ·
 * `N new` (or `Failed`) · relative time, clickable through to the runs
 * page with that run selected. Reuses `navigate({ name: 'runs' })`, the
 * same mechanism the `conflict`/`failed` secondary actions above already
 * use — RunsPage default-selects the newest run once its list resolves
 * (RunsPage.tsx), which is exactly the run this line describes. Renders
 * only once `lastRunStatus` is non-null (ux-notes §9's "first-ever load:
 * button only, no status line"), independent of `state.kind` and of
 * `DONE_WINDOW_MS` — the whole point of B24's decoupling. */
function LastRunStatusLine({ control }: { control: RunControlHandle }) {
  const { lastRunStatus } = control;
  if (lastRunStatus === null) return null;

  const dotClassName =
    lastRunStatus.kind === 'done' ? 'bg-success-strong' : 'bg-destructive';
  const outcomeLabel =
    lastRunStatus.kind === 'done' ? `${lastRunStatus.newCount} new` : 'Failed';

  return (
    <button
      type="button"
      data-testid="run-now-last-status"
      onClick={() => navigate({ name: 'runs' })}
      className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotClassName}`} />
      <span>{outcomeLabel}</span>
      <span aria-hidden>·</span>
      <span>{formatRelative(lastRunStatus.finishedAt, new Date())}</span>
    </button>
  );
}

/** The sidebar's run-control affordance (spec §3.6). Icon-only when the
 * sidebar rail is collapsed — the secondary affordance (Cancel / Queue
 * again / View run), the daemon-down copy button, and the persistent
 * status line all have no room in the collapsed rail and are hidden there,
 * matching how NAV_ITEMS' own labels already disappear when collapsed. */
export function RunNowButton({
  control,
  collapsed,
}: {
  control: RunControlHandle;
  collapsed: boolean;
}) {
  const { state, label, onRun, isSubmitting, error } = control;
  const disabled = isSubmitting || state.kind === 'running';
  const secondary = secondaryFor(control);
  const tone = toneClassNameFor(state.kind);

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        data-testid="run-now"
        variant={tone ? 'outline' : 'default'}
        className={tone ?? undefined}
        size={collapsed ? 'icon' : 'default'}
        aria-label={collapsed ? label : undefined}
        disabled={disabled}
        onClick={onRun}
      >
        {collapsed ? <Play className="size-4" /> : label}
      </Button>
      {!collapsed && state.kind === 'daemon-down' && (
        <div className="flex flex-col gap-1">
          <CopyServeStartButton />
        </div>
      )}
      {!collapsed && secondary.length > 0 && (
        <div className="flex flex-col gap-1">
          {secondary.map((action) => (
            <Button
              key={action.label}
              type="button"
              data-testid="run-now-secondary"
              variant="ghost"
              size="sm"
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
          {secondary[0]?.hint && (
            <p className="text-xs text-muted-foreground">{secondary[0].hint}</p>
          )}
        </div>
      )}
      {!collapsed && error && (
        <p data-testid="run-now-error" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!collapsed && <LastRunStatusLine control={control} />}
    </div>
  );
}
