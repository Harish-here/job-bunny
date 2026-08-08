import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';
import type { ConfigDocName } from './config.api';
import { configDocQuery } from './config.queries';
import { useConfigMutation } from './useConfigMutation';

// The one "Edit as JSON" hatch every Settings tab carries, rendered once
// centrally by SettingsPage (never duplicated inside a section — see
// Rationale). Reads via the SAME configDocQuery a section's own
// useDocForm primes (a cache hit on open) and writes via the SAME
// useConfigMutation path, never a bespoke write surface.
export function JsonEscapeHatch({
  profile,
  doc,
}: {
  profile: string;
  doc: ConfigDocName;
}) {
  const query = useQuery(configDocQuery(profile, doc));
  const mutation = useConfigMutation(profile, doc);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // Seed only when the dialog opens — a background refetch while closed
  // never silently changes what the next open shows mid-typing.
  useEffect(() => {
    if (open && query.data) setDraft(query.data.text);
  }, [open, query.data]);

  async function handleSave() {
    try {
      await mutation.mutateAsync(draft);
      setOpen(false);
    } catch {
      // Rejection leaves the dialog open; mutation.error renders inline below.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings-json-open"
        >
          Edit as JSON
        </Button>
      </DialogTrigger>
      {/* A real config doc (e.g. rajni's filter.json) is tall enough that
          the header + a 16-row textarea + footer can exceed the viewport;
          `DialogContent` itself is `fixed`-positioned (no ambient page
          scroll reaches it), so without its own scroll region the Save
          button can end up permanently off-screen. Capped height + its own
          scroll keeps every control reachable regardless of doc size. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Edit ${doc}`}</DialogTitle>
          <DialogDescription>
            Raw document text — saving here writes the whole document, through the same
            path the form uses.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label={`${doc} raw text`}
          data-testid="settings-json-textarea"
          className="font-mono"
          rows={16}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {mutation.isError && (
          <p data-testid="settings-error" className="text-sm text-destructive">
            {mutation.error.message}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            data-testid="settings-json-save"
            disabled={mutation.isPending}
            onClick={handleSave}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
