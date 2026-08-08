import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ConfigDocName } from './config.api';
import { configDocQuery } from './config.queries';
import { useConfigMutation } from './useConfigMutation';

export interface UseDocFormResult {
  rawText: string;
  value: Record<string, unknown> | null;
  parseError: boolean;
  isLoading: boolean;
  isSaving: boolean;
  serverError: string | null;
  save: (mutate: (value: Record<string, unknown>) => void) => Promise<boolean>;
}

// An empty doc parses to `{}`, never a parse error; malformed JSON gives a
// null value with `parseError: true`. Shared by the render-time parse and
// by `save`'s re-parse-at-call-time.
function parseDoc(text: string): {
  value: Record<string, unknown> | null;
  parseError: boolean;
} {
  const trimmed = text.trim();
  if (trimmed === '') return { value: {}, parseError: false };
  try {
    const parsed: unknown = JSON.parse(text);
    const value =
      parsed != null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    return { value, parseError: false };
  } catch {
    return { value: null, parseError: true };
  }
}

// The shared read-modify-write seam every section uses: `save` re-parses
// the CURRENT raw text at call time (never a value captured at mount),
// applies the caller's mutation, and PUTs the whole doc back — unknown
// keys survive because the mutation edits a live parsed copy, never a
// fresh document built from scratch.
export function useDocForm(profile: string, doc: ConfigDocName): UseDocFormResult {
  const query = useQuery(configDocQuery(profile, doc));
  const mutation = useConfigMutation(profile, doc);
  const [rawText, setRawText] = useState('');

  // Tracks which (profile, doc) pair `rawText` was last synced FOR — not
  // just whether a sync has ever happened. `query.isPending` flips to
  // `false` on the same render `query.isSuccess` first becomes true, one
  // render before this effect (which runs post-commit) has copied that
  // data into `rawText`; without this, `isLoading` below would go false
  // for one render while `rawText`/`value` still reflect the pre-load
  // state, which a caller's one-shot "seed my form" effect can latch onto
  // and never revisit. This MUST be its own `useState`, not a `useRef`:
  // when the loaded text happens to equal the current `rawText` (e.g. an
  // empty doc matching the initial `''`), `setRawText` is a no-op React
  // bails on an identical primitive) and a bare ref mutation triggers no
  // render at all, so nothing would ever recompute `isLoading` with the
  // ref's new value. A real state update guarantees the render happens.
  const [syncedFor, setSyncedFor] = useState<string | null>(null);

  // Reset only on the initial load succeeding, never a later background
  // refetch — an external `jobbunny config set` never stomps an edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  useEffect(() => {
    if (query.isSuccess) {
      setRawText(query.data.text);
      setSyncedFor(`${profile}:${doc}`);
    }
  }, [profile, doc, query.isSuccess]);

  const { value, parseError } = parseDoc(rawText);
  const isLoading = query.isPending || syncedFor !== `${profile}:${doc}`;

  async function save(
    mutate: (value: Record<string, unknown>) => void,
  ): Promise<boolean> {
    const parsed = parseDoc(rawText);
    if (parsed.value == null) return false;
    mutate(parsed.value);
    const text = `${JSON.stringify(parsed.value, null, 2)}\n`;
    try {
      await mutation.mutateAsync(text);
      return true;
    } catch {
      return false;
    }
  }

  return {
    rawText,
    value,
    parseError,
    isLoading,
    isSaving: mutation.isPending,
    serverError: mutation.error?.message ?? null,
    save,
  };
}
