import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { Textarea } from '../../components/ui/textarea';
import type { ConfigDocName } from './config.api';
import { configDocQuery } from './config.queries';
import { useConfigMutation } from './useConfigMutation';

const DOCS: ConfigDocName[] = [
  'profile.json',
  'filter.json',
  'resume.json',
  'search_urls.md',
];

/**
 * One doc's raw-text editor. Local draft state is seeded from the query's
 * data and reset ONLY when `profile` changes or the query's initial load
 * for this (profile, doc) pair completes — never on a later background
 * refetch of the SAME pair (so typing isn't stomped by, say, an external
 * `jobbunny config set` landing mid-edit). Mirrors `TrackingPanel`'s
 * reset-on-identity-change `useEffect`, keyed here on `profile` (doc is
 * fixed per editor instance) plus `query.isSuccess`'s pending→true edge
 * rather than the raw `data` value, which is what keeps a background
 * refetch from re-firing the reset.
 */
function ConfigDocEditor({ profile, doc }: { profile: string; doc: ConfigDocName }) {
  const query = useQuery(configDocQuery(profile, doc));
  const mutation = useConfigMutation(profile, doc);
  const [draft, setDraft] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — see doc comment above
  useEffect(() => {
    if (query.isSuccess) setDraft(query.data.text);
  }, [profile, doc, query.isSuccess]);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm font-medium">{doc}</h2>
        {mutation.isPending && (
          <span className="text-xs text-muted-foreground">Saving…</span>
        )}
      </div>

      {query.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : query.isError ? (
        <span className="text-sm text-destructive">
          Couldn't load {doc}: {query.error.message}
        </span>
      ) : (
        <>
          <Textarea
            aria-label={doc}
            className="font-mono"
            rows={10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(draft)}
            >
              Save {doc}
            </Button>
          </div>
          {mutation.isError && (
            <span className="text-sm text-destructive">{mutation.error.message}</span>
          )}
        </>
      )}
    </section>
  );
}

export function SettingsPage({ profile }: { profile: string }) {
  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold font-heading">Settings</h1>
      {DOCS.map((doc) => (
        <ConfigDocEditor key={doc} profile={profile} doc={doc} />
      ))}
    </div>
  );
}
