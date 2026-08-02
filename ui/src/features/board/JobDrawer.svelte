<script lang="ts">
  import { ApiError } from '../../lib/api/client';
  import type { BoardDetailResponse, TrackingRow } from '../../lib/api/types';
  import { getJob } from './api';
  import TrackingForm from './TrackingForm.svelte';

  let {
    profile,
    jobId,
    statusOptions,
    onclose,
    ontracking,
  }: {
    profile: string;
    jobId: string;
    statusOptions: string[];
    onclose: () => void;
    ontracking: (jobId: string, tracking: TrackingRow | null) => void;
  } = $props();

  let detail = $state<BoardDetailResponse | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void load(profile, jobId);
  });

  async function load(name: string, id: string) {
    detail = null;
    error = null;
    try {
      detail = await getJob(name, id);
    } catch (err) {
      error =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
    }
  }

  function handleTracking(id: string, tracking: TrackingRow | null) {
    if (detail && detail.id === id) detail = { ...detail, tracking };
    ontracking(id, tracking);
  }
</script>

<aside class="drawer">
  <button type="button" class="close" onclick={onclose} aria-label="Close">×</button>
  {#if error}
    <p class="error">{error}</p>
  {:else if !detail}
    <p class="empty">Loading…</p>
  {:else}
    <h2>{detail.title}</h2>
    <p class="company">
      {detail.company} ·
      <a href={detail.url} target="_blank" rel="noreferrer">posting ↗</a>
    </p>
    <dl class="meta">
      <dt>Found</dt>
      <dd>{detail.dateFound.slice(0, 10)}</dd>
      <dt>Location</dt>
      <dd>{detail.locationCity ?? '—'}{detail.workType ? ` · ${detail.workType}` : ''}</dd>
      <dt>Score</dt>
      <dd>{detail.score ?? '—'}</dd>
      <dt>Excitement</dt>
      <dd>{detail.excitement ?? '—'}</dd>
      {#if detail.skills.length > 0}
        <dt>Skills</dt>
        <dd>{detail.skills.join(', ')}</dd>
      {/if}
      {#if detail.matchReasons.length > 0}
        <dt>Match</dt>
        <dd>{detail.matchReasons.join('; ')}</dd>
      {/if}
      {#if detail.reviewFlags.length > 0}
        <dt>Flags</dt>
        <dd>⚑ {detail.reviewFlags.join('; ')}</dd>
      {/if}
    </dl>

    <TrackingForm
      {profile}
      jobId={detail.id}
      tracking={detail.tracking}
      {statusOptions}
      ontracking={handleTracking}
    />

    {#if detail.jd.content?.rawText}
      <h3>Job description</h3>
      <pre class="jd">{detail.jd.content.rawText}</pre>
    {/if}
  {/if}
</aside>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 90vw);
    overflow-y: auto;
    background: Canvas;
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15);
    padding: 1rem 1.25rem;
    z-index: 10;
  }

  .close {
    position: absolute;
    top: 0.6rem;
    right: 0.8rem;
    font-size: 1.4rem;
    border: none;
    background: none;
    cursor: pointer;
  }

  .drawer h2 {
    margin: 0.25rem 0 0.25rem;
    padding-right: 2rem;
  }

  .company {
    color: var(--muted);
    margin-top: 0;
  }

  .meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.9rem;
    font-size: 0.88rem;
  }

  .meta dt {
    color: var(--muted);
  }

  .meta dd {
    margin: 0;
  }

  .jd {
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.45;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
</style>
