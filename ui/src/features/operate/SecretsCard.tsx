/**
 * Operate's Secrets card (blueprint step 36, component half —
 * blueprint.md:1124-1128). Two rows, `NOTION_TOKEN` and
 * `TELEGRAM_BOT_TOKEN`, each showing `configured`/`not configured` from
 * the existing `GET /api/secrets` — a presence-ONLY read
 * (`app/features/secrets/routes.ts`'s `listSecrets()`). No endpoint, and
 * no code path in this file, ever resolves an actual secret value: the
 * `[Set]` dialog's password `Input` starts empty on every open (there is
 * nothing to prefill it with — the presence read never returns one), is
 * read exactly once at submit time into a local variable, handed to the
 * existing `putSecret()` (`wizard.api.ts`, reused unchanged), and never
 * stored in component state that could be re-rendered.
 *
 * "not configured" resolves to the `attention` tone (never plain `amber`)
 * — the same substitution `SetupHealthCard.tsx`'s `STATUS_TONE` already
 * makes for its own `warn` status, for the same reason: the design scale
 * flags plain `--amber` as failing 4.5:1 for body text and defines no
 * `--amber-strong` counterpart, where `--attention-strong` exists exactly
 * for this (the `-strong` text rule).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Field, FieldControl, FieldLabel } from '../../components/ui/form';
import { Input } from '../../components/ui/input';
import { Skeleton } from '../../components/ui/skeleton';
import { getJson } from '../../lib/api/client';
import type { SecretKey, SecretPresence } from '../../lib/api/types';
import { putSecret } from '../wizard/wizard.api';

const SECRETS_QUERY_KEY = ['secrets'] as const;

// The two allowlisted keys, in the mockup's own row order — the only keys
// this card, or the server it talks to, ever accepts (blueprint step 36:
// "Only the two allowlisted keys are writable").
const ROWS: ReadonlyArray<{ key: SecretKey; rowQa: string }> = [
  { key: 'NOTION_TOKEN', rowQa: 'secret-row-notion-token' },
  { key: 'TELEGRAM_BOT_TOKEN', rowQa: 'secret-row-telegram-bot-token' },
];

function getSecrets(): Promise<SecretPresence> {
  return getJson('/api/secrets');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One row's `configured`/`not configured` word + dot. `present` is
 * `undefined` only while the parent's own loading/error states haven't
 * yet produced a `SecretPresence` for this key — callers only render this
 * once `secrets.data` exists, so that case never actually reaches here. */
function StatusWord({ present }: { present: 'present' | 'absent' | undefined }) {
  const configured = present === 'present';
  const wordClass = configured ? 'text-success-strong' : 'text-attention-strong';
  const dotClass = configured ? 'bg-success' : 'bg-attention';
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${wordClass}`}>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotClass}`} />
      {configured ? 'configured' : 'not configured'}
    </span>
  );
}

/** One `NOTION_TOKEN`/`TELEGRAM_BOT_TOKEN` row plus its `[Set]` dialog. Kept
 * as a per-row component, like `ScheduledRunsCard.tsx`'s `ScheduleRow`, so
 * each row owns its own dialog-open/input/mutation state independently. */
function SecretRow({
  secretKey,
  rowQa,
  present,
}: {
  secretKey: SecretKey;
  rowQa: string;
  present: 'present' | 'absent' | undefined;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  const mutation = useMutation({
    mutationFn: (submitted: string) => putSecret(secretKey, submitted),
    onSuccess: () => {
      setOpen(false);
      setValue('');
      qc.invalidateQueries({ queryKey: SECRETS_QUERY_KEY });
    },
  });

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setValue('');
      mutation.reset();
    }
  }

  return (
    <tr data-qa={rowQa}>
      <td className="py-1.5 pr-2 font-mono text-xs">{secretKey}</td>
      <td className="py-1.5 pr-2">
        <StatusWord present={present} />
      </td>
      <td className="py-1.5">
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            Set
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set {secretKey}</DialogTitle>
              <DialogDescription>
                Write-only. The value is never shown again once saved.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel>Value</FieldLabel>
              <FieldControl>
                <Input
                  type="password"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </FieldControl>
            </Field>
            {mutation.isError && (
              <p className="text-sm text-destructive">
                Couldn't save: {getErrorMessage(mutation.error)}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                disabled={value === '' || mutation.isPending}
                onClick={() => mutation.mutate(value)}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

/** The Operate page's Secrets card (blueprint step 36). All-profiles scope
 * — secrets live in the data home's `.env`, not per profile — hence the
 * `All profiles` badge and no `profile` prop. */
export function SecretsCard() {
  const secrets = useQuery({ queryKey: SECRETS_QUERY_KEY, queryFn: getSecrets });

  if (secrets.isError) {
    return (
      <Card data-qa="card-secrets" size="sm" className="col-span-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Secrets
            <Badge
              variant="outline"
              className="border-transparent bg-muted text-muted-foreground"
            >
              All profiles
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Can't reach the secrets API</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => secrets.refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!secrets.data) {
    return (
      <Card data-qa="card-secrets" size="sm" className="col-span-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Secrets
            <Badge
              variant="outline"
              className="border-transparent bg-muted text-muted-foreground"
            >
              All profiles
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-qa="card-secrets" size="sm" className="col-span-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Secrets
          <Badge
            variant="outline"
            className="border-transparent bg-muted text-muted-foreground"
          >
            All profiles
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <table className="w-full text-sm">
          <tbody>
            {ROWS.map((row) => (
              <SecretRow
                key={row.key}
                secretKey={row.key}
                rowQa={row.rowQa}
                present={secrets.data[row.key]}
              />
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">Write-only. Value never rendered.</p>
      </CardContent>
    </Card>
  );
}
