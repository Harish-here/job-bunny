<script lang="ts">
  import type { TrackingPatchBody, TrackingRow } from '../../lib/api/types';
  import { patchTracking } from './api';
  import { commitField } from './tracking';

  let {
    profile,
    jobId,
    tracking,
    statusOptions,
    ontracking,
  }: {
    profile: string;
    jobId: string;
    tracking: TrackingRow | null;
    statusOptions: string[];
    ontracking: (jobId: string, tracking: TrackingRow | null) => void;
  } = $props();

  let fieldState = $state<
    Partial<Record<keyof TrackingPatchBody, { saving: boolean; error: string | null }>>
  >({});
  const anySaving = $derived(Object.values(fieldState).some((s) => s?.saving));

  async function commit(field: keyof TrackingPatchBody, raw: string) {
    fieldState[field] = { saving: true, error: null };
    const error = await commitField(jobId, field, raw, {
      read: () => tracking,
      patch: (p) => patchTracking(profile, jobId, p).then((r) => r.tracking),
      apply: (t) => ontracking(jobId, t),
    });
    fieldState[field] = { saving: false, error };
  }
</script>

<form class="tracking" onsubmit={(e) => e.preventDefault()}>
  <h3>Tracking {#if anySaving}<span class="saving">saving…</span>{/if}</h3>
  {#each Object.entries(fieldState) as [f, s] (f)}
    {#if s?.error}
      <p class="error">Save failed on {f} — rolled back: {s.error}</p>
    {/if}
  {/each}

  <label>
    Status
    <select
      value={tracking?.status ?? ''}
      onchange={(e) => commit('status', e.currentTarget.value)}
    >
      <option value="">—</option>
      {#each statusOptions as s (s)}
        <option value={s}>{s}</option>
      {/each}
    </select>
  </label>

  <label>
    Date applied
    <input
      type="date"
      value={tracking?.dateApplied ?? ''}
      onchange={(e) => commit('dateApplied', e.currentTarget.value)}
    />
  </label>

  <label>
    Comp range
    <input
      maxlength="500"
      value={tracking?.compRange ?? ''}
      onchange={(e) => commit('compRange', e.currentTarget.value)}
    />
  </label>

  <label>
    Contact
    <input
      maxlength="500"
      value={tracking?.contact ?? ''}
      onchange={(e) => commit('contact', e.currentTarget.value)}
    />
  </label>

  <label>
    Next action
    <input
      maxlength="500"
      value={tracking?.nextAction ?? ''}
      onchange={(e) => commit('nextAction', e.currentTarget.value)}
    />
  </label>

  <label>
    Next action date
    <input
      type="date"
      value={tracking?.nextActionDate ?? ''}
      onchange={(e) => commit('nextActionDate', e.currentTarget.value)}
    />
  </label>

  <label>
    Notes
    <textarea
      rows="3"
      maxlength="5000"
      value={tracking?.notes ?? ''}
      onchange={(e) => commit('notes', e.currentTarget.value)}
    ></textarea>
  </label>
</form>

<style>
  .tracking {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem 0.8rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    margin: 1rem 0;
  }

  .tracking h3 {
    grid-column: 1 / -1;
    margin: 0;
  }

  .tracking .saving {
    font-size: 0.8rem;
    font-weight: 400;
    color: var(--muted);
  }

  .tracking label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .tracking label:has(textarea) {
    grid-column: 1 / -1;
  }

  .tracking select,
  .tracking input,
  .tracking textarea {
    font: inherit;
    color: inherit;
    padding: 0.3rem 0.4rem;
  }

  .tracking .error {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 0.85rem;
  }
</style>
