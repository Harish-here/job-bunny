/** Removes a profile's local SQLite database, config documents, and run
 * history (Notion untouched) via DELETE /api/profiles/:name — the ONLY
 * call this component makes. The running-run/pending-intent disable is a
 * COURTESY mirror of the server's own 409 guards, not a replacement for
 * them; a 409 that arrives anyway is still rendered verbatim. A refusal of
 * any server-designated undeletable fixture profile is enforced entirely
 * server-side — no hardcoded name check here. See this brief's Rationale.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../components/ui/dialog';
import { Field, FieldControl, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { navigate } from '../../../lib/router';
import { runIntentsQuery } from '../../runcontrol/runcontrol.queries';
import { runsQuery } from '../../runs/runs.queries';
import { profilesKeys } from '../../shell/profiles.queries';
import { deleteProfile } from '../config.api';

const RUN_IN_PROGRESS_MESSAGE =
  'This profile has a run in progress — wait for it to finish before removing the profile.';
const INTENT_PENDING_MESSAGE =
  'This profile has a run queued — cancel or wait for it before removing the profile.';

export function DangerZone({ profile }: { profile: string }) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const qc = useQueryClient();

  const runsQ = useQuery(runsQuery(profile));
  const intentsQ = useQuery(runIntentsQuery(profile));
  const hasRunningRun = (runsQ.data?.rows ?? []).some((r) => r.status === 'running');
  const hasPendingIntent = (intentsQ.data?.rows ?? []).some(
    (i) => i.status === 'pending',
  );
  const blockedMessage = hasRunningRun
    ? RUN_IN_PROGRESS_MESSAGE
    : hasPendingIntent
      ? INTENT_PENDING_MESSAGE
      : null;

  const canConfirm = confirmText === profile && blockedMessage === null;

  async function handleConfirm() {
    setError(null);
    setIsSubmitting(true);
    try {
      await deleteProfile(profile);
      await qc.invalidateQueries({ queryKey: profilesKeys.all });
      setOpen(false);
      navigate({ name: 'setup' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Removing a profile permanently deletes its local SQLite database, its
        configuration documents, and its run history. Notion is never touched.
      </p>
      {blockedMessage && (
        <p className="text-sm text-attention-strong">{blockedMessage}</p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setConfirmText('');
            setError(null);
          }
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" variant="destructive" data-testid="danger-open">
            Remove this profile
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {profile}?</DialogTitle>
            <DialogDescription>
              This permanently deletes {profile}'s local SQLite database, its
              configuration documents, and its run history. Notion is never touched. Type
              "{profile}" to confirm.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Profile name</FieldLabel>
            <FieldControl>
              <Input
                data-testid="danger-confirm-input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </FieldControl>
          </Field>
          {error && <p data-testid="settings-error">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              data-testid="danger-confirm"
              disabled={!canConfirm || isSubmitting}
              onClick={handleConfirm}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
