import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Input } from '../../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Separator } from '../../components/ui/separator';
import { Textarea } from '../../components/ui/textarea';
import type { BoardJobRow, TrackingPatchBody, TrackingRow } from '../../lib/api/types';
import { useMeta } from '../board/useBoardData';
import { fieldPatch, useTrackingMutation } from '../board/useTracking';

const CLEAR = '__clear__';

interface Drafts {
  compRange: string;
  contact: string;
  nextAction: string;
  notes: string;
  dateApplied: string;
  nextActionDate: string;
}

function draftsFrom(tracking: TrackingRow | null): Drafts {
  return {
    compRange: tracking?.compRange ?? '',
    contact: tracking?.contact ?? '',
    nextAction: tracking?.nextAction ?? '',
    notes: tracking?.notes ?? '',
    dateApplied: tracking?.dateApplied ?? '',
    nextActionDate: tracking?.nextActionDate ?? '',
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * Shared tracking form for the triage detail pane (T8) and the full-page job
 * view (T10). Every field commits independently — blur for free-text
 * inputs and the two date inputs, change for the status select — never a
 * whole-form save. Date inputs commit on blur (not change) because a native
 * date input mid-edit reports an empty value, which would otherwise fire a
 * spurious clear. `fieldPatch` supplies the no-op guard (unchanged value
 * fires no PATCH) and the empty-string-clears-the-field semantics.
 */
export function TrackingPanel({ profile, job }: { profile: string; job: BoardJobRow }) {
  const metaQuery = useMeta(profile);
  const mutation = useTrackingMutation(profile);
  const tracking = job.tracking ?? null;

  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(tracking));
  // Reset local drafts only when the selected job changes — not on every
  // tracking update, or a just-committed edit (which round-trips through
  // the cache) would stomp what the user is mid-typing in another field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — see above
  useEffect(() => {
    setDrafts(draftsFrom(tracking));
  }, [job.id]);

  function commit(field: keyof TrackingPatchBody, raw: string): void {
    const patch = fieldPatch(tracking, field, raw);
    if (patch) mutation.mutate({ jobId: job.id, patch });
  }

  function setDraft(field: keyof Drafts, value: string): void {
    setDrafts((d) => ({ ...d, [field]: value }));
  }

  return (
    <details open className="rounded-lg border">
      <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-2 text-sm font-medium">
        <span>Tracking</span>
        {mutation.isPending && (
          <span className="text-xs font-normal text-muted-foreground">Saving…</span>
        )}
      </summary>
      <Separator />
      <div className="flex flex-col gap-3 p-4">
        <Field label="Status">
          <Select
            value={tracking?.status ?? CLEAR}
            onValueChange={(v) => commit('status', v === CLEAR ? '' : v)}
          >
            <SelectTrigger className="w-full" aria-label="Status">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CLEAR}>—</SelectItem>
              {(metaQuery.data?.statusOptions ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Date applied">
          <input
            type="date"
            aria-label="Date applied"
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            value={drafts.dateApplied}
            onChange={(e) => setDraft('dateApplied', e.target.value)}
            onBlur={(e) => commit('dateApplied', e.target.value)}
          />
        </Field>

        <Field label="Comp range">
          <Input
            aria-label="Comp range"
            maxLength={500}
            value={drafts.compRange}
            onChange={(e) => setDraft('compRange', e.target.value)}
            onBlur={(e) => commit('compRange', e.target.value)}
          />
        </Field>

        <Field label="Contact">
          <Input
            aria-label="Contact"
            maxLength={500}
            value={drafts.contact}
            onChange={(e) => setDraft('contact', e.target.value)}
            onBlur={(e) => commit('contact', e.target.value)}
          />
        </Field>

        <Field label="Next action">
          <Input
            aria-label="Next action"
            maxLength={500}
            value={drafts.nextAction}
            onChange={(e) => setDraft('nextAction', e.target.value)}
            onBlur={(e) => commit('nextAction', e.target.value)}
          />
        </Field>

        <Field label="Next action date">
          <input
            type="date"
            aria-label="Next action date"
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            value={drafts.nextActionDate}
            onChange={(e) => setDraft('nextActionDate', e.target.value)}
            onBlur={(e) => commit('nextActionDate', e.target.value)}
          />
        </Field>

        <Field label="Notes">
          <Textarea
            aria-label="Notes"
            maxLength={5000}
            rows={3}
            value={drafts.notes}
            onChange={(e) => setDraft('notes', e.target.value)}
            onBlur={(e) => commit('notes', e.target.value)}
          />
        </Field>
      </div>
    </details>
  );
}
