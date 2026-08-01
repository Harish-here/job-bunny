<script lang="ts">
  import { ApiError } from '../../lib/api/client';
  import type {
    BoardListResponse,
    BoardMetaResponse,
    ListQuery,
    TrackingRow,
  } from '../../lib/api/types';
  import { getMeta, listJobs } from './api';
  import FilterBar from './FilterBar.svelte';
  import JobTable from './JobTable.svelte';

  let { profile }: { profile: string } = $props();

  let query = $state<ListQuery>({
    archived: 'false',
    sort: 'date_found',
    order: 'desc',
    limit: 50,
    offset: 0,
  });
  let data = $state<BoardListResponse | null>(null);
  let meta = $state<BoardMetaResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let noDb = $state(false);
  let selectedId = $state<string | null>(null);
  let seq = 0;

  $effect(() => {
    void loadMeta(profile);
  });

  $effect(() => {
    // Spread reads every query key synchronously so the effect re-runs on
    // any filter change (query is reassigned wholesale by patchQuery).
    void load(profile, { ...query });
  });

  async function loadMeta(name: string) {
    try {
      meta = await getMeta(name);
    } catch {
      meta = null; // option lists are cosmetic; the table still renders
    }
  }

  async function load(name: string, q: ListQuery) {
    const mine = ++seq;
    loading = true;
    try {
      const res = await listJobs(name, q);
      if (mine !== seq) return; // a newer request superseded this one
      data = res;
      error = null;
      noDb = false;
    } catch (err) {
      if (mine !== seq) return;
      data = null;
      noDb = err instanceof ApiError && err.code === 'no_local_db';
      error = noDb ? null : err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  function patchQuery(patch: Partial<ListQuery>) {
    query = { ...query, ...patch, offset: 0 };
    selectedId = null;
  }

  function toggleSort(col: 'date_found' | 'score') {
    if (query.sort === col) {
      patchQuery({ order: query.order === 'asc' ? 'desc' : 'asc' });
    } else {
      patchQuery({ sort: col, order: 'desc' });
    }
  }

  function page(delta: number) {
    const limit = query.limit ?? 50;
    query = { ...query, offset: Math.max(0, (query.offset ?? 0) + delta * limit) };
  }

  function onTracking(jobId: string, tracking: TrackingRow | null) {
    if (!data) return;
    data = {
      ...data,
      rows: data.rows.map((r) => (r.id === jobId ? { ...r, tracking } : r)),
    };
  }
</script>

<section class="board">
  <header class="board-head">
    <h1>Board</h1>
    <FilterBar {query} {meta} onchange={patchQuery} />
  </header>

  {#if noDb}
    <p class="empty">
      Profile “{profile}” has no local database yet — populate it with a pipeline run or
      <code>jobbunny migrate</code>.
    </p>
  {:else if error}
    <p class="error">Could not load jobs: {error}</p>
  {:else if data && data.rows.length === 0}
    <p class="empty">No jobs match the current filters.</p>
  {:else if data}
    <JobTable
      rows={data.rows}
      sort={query.sort ?? 'date_found'}
      order={query.order ?? 'desc'}
      onsort={toggleSort}
      onselect={(id) => (selectedId = id)}
    />
    <footer class="pager">
      <button type="button" disabled={(query.offset ?? 0) === 0} onclick={() => page(-1)}>
        Prev
      </button>
      <span>
        {(query.offset ?? 0) + 1}–{Math.min(
          (query.offset ?? 0) + (query.limit ?? 50),
          data.total,
        )} of {data.total}
      </span>
      <button
        type="button"
        disabled={(query.offset ?? 0) + (query.limit ?? 50) >= data.total}
        onclick={() => page(1)}
      >
        Next
      </button>
    </footer>
  {:else if loading}
    <p class="empty">Loading…</p>
  {/if}

  <!-- JobDrawer mounts here in the next task, driven by selectedId/onTracking. -->
</section>

<style>
  .board-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }

  .board-head h1 {
    margin: 0;
  }

  .pager {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0;
  }
</style>
