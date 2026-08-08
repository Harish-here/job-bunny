import { Play } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { navigate } from '../../lib/router';
import type { RunControlHandle } from './useRunControl';

interface SecondaryAction {
  label: string;
  onClick: () => void;
  hint?: string;
}

function secondaryFor(control: RunControlHandle): SecondaryAction | null {
  switch (control.state.kind) {
    case 'queued':
      return { label: 'Cancel', onClick: control.onCancel };
    case 'expired':
      return {
        label: 'Queue again',
        onClick: control.onRun,
        hint: 'Start the daemon with: jobbunny serve start',
      };
    case 'conflict':
    case 'failed':
      return { label: 'View run', onClick: () => navigate({ name: 'runs' }) };
    default:
      return null;
  }
}

/** The sidebar's run-control affordance (spec §3.6). Icon-only when the
 * sidebar rail is collapsed — the secondary affordance (Cancel / Queue
 * again / View run) has no room in the collapsed rail and is hidden there,
 * matching how NAV_ITEMS' own labels already disappear when collapsed. */
export function RunNowButton({
  control,
  collapsed,
}: {
  control: RunControlHandle;
  collapsed: boolean;
}) {
  const { state, label, onRun, isSubmitting } = control;
  const disabled = isSubmitting || state.kind === 'running';
  const secondary = secondaryFor(control);

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        data-testid="run-now"
        size={collapsed ? 'icon' : 'default'}
        aria-label={collapsed ? label : undefined}
        disabled={disabled}
        onClick={onRun}
      >
        {collapsed ? <Play className="size-4" /> : label}
      </Button>
      {!collapsed && secondary && (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            data-testid="run-now-secondary"
            variant="ghost"
            size="sm"
            onClick={secondary.onClick}
          >
            {secondary.label}
          </Button>
          {secondary.hint && (
            <p className="text-xs text-muted-foreground">{secondary.hint}</p>
          )}
        </div>
      )}
    </div>
  );
}
