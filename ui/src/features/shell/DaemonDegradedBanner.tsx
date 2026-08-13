import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Copy, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { daemonQuery } from '../wizard/wizard.queries';

const RESTART_COMMAND = 'jobbunny serve stop && jobbunny serve start';

/** Global, session-dismissible strip shown when the daemon has stopped
 * starting runs for this profile because its own schema is behind the
 * database's (blueprint.md 0.3 / mockup.html:679-698). Deliberately the
 * only amber element on screen — `text-attention-strong` on every line,
 * `bg-attention/10`/`border-attention` on the strip itself, never
 * `text-attention` (design-scale rule).
 *
 * The copy button duplicates `Step6Launch.tsx`'s `DaemonStartHint` /
 * `RunNowButton.tsx`'s `CopyServeStartButton` clipboard pattern locally —
 * this is the third independent copy, kept duplicated per the frozen
 * design (blueprint.md §8 NOTES: no shared non-shadcn component folder
 * convention exists yet, and introducing one is out of this task's
 * proportional scope). */
export function DaemonDegradedBanner({ profile }: { profile: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const daemon = useQuery(daemonQuery());

  const entry = daemon.data?.profiles.find((p) => p.profile === profile);
  if (!entry || !entry.degraded || dismissed) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(RESTART_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser sandbox; the
      // command is still visible to copy by hand, so this never throws.
    }
  }

  return (
    <div
      data-testid="daemon-degraded-banner"
      data-qa="daemon-degraded-banner"
      className="rounded-md border-b border-attention bg-attention/10"
    >
      <div className="flex items-start gap-3 p-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-attention-strong" />
        <div className="flex-1">
          <p className="text-sm font-medium text-attention-strong">
            The scheduler has STOPPED starting runs.
          </p>
          <p
            data-testid="daemon-degraded-cause"
            data-qa="daemon-degraded-cause"
            className="mt-1 text-xs text-attention-strong"
          >
            {entry.degradedReason}
          </p>
          <p
            data-testid="daemon-degraded-remedy"
            data-qa="daemon-degraded-remedy"
            className="mt-1 text-xs text-attention-strong"
          >
            Fix: restart the daemon —
          </p>
          <div
            data-testid="daemon-degraded-command"
            data-qa="daemon-degraded-command"
            className="mt-1.5 flex max-w-xs items-center gap-2 rounded-md bg-muted/50 px-3 py-2 font-mono text-xs"
          >
            <span>{RESTART_COMMAND}</span>
            <Button
              type="button"
              data-testid="daemon-degraded-copy-button"
              data-qa="daemon-degraded-copy-button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={handleCopy}
            >
              <Copy className="size-3" />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss for this session"
          className="ml-auto border-0 bg-transparent text-attention-strong"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
