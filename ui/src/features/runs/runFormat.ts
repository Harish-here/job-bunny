import type { RunSummary } from '../../lib/api/types';

/** Human-readable elapsed time between `startedAt` and `finishedAt` — `—`
 * while the run is still open (no `finishedAt` yet) or on a malformed pair. */
export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (finishedAt == null) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'success'
  | 'running'
  | 'outline';

export function statusVariant(status: RunSummary['status']): BadgeVariant {
  switch (status) {
    case 'passed':
      return 'success';
    case 'failed':
    case 'crashed':
      return 'destructive';
    case 'running':
      return 'running';
    default:
      return 'outline';
  }
}

export function statusLabel(status: RunSummary['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
