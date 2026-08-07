import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigDocName } from './config.api';
import { putConfigDoc } from './config.api';
import { configKeys } from './config.queries';

/**
 * One doc-save mutation. Unlike `useTrackingMutation`, no optimistic
 * update — a raw-text editor's "current value" is just its own draft
 * state until Save succeeds, and there's no list/detail cache fan-out to
 * keep in sync. On error, the mutation's own `error`/`isError` surfaces
 * to the CALLING component (no global toast) — the 422 message needs to
 * reach the specific editor that failed.
 */
export function useConfigMutation(profile: string, doc: ConfigDocName) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => putConfigDoc(profile, doc, text),
    onSuccess: (data) => {
      qc.setQueryData(configKeys.doc(profile, doc), data);
    },
  });
}
