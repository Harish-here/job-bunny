<script lang="ts">
  import type { BoardMetaResponse, ListQuery } from '../../lib/api/types';

  let {
    query,
    meta,
    onchange,
  }: {
    query: ListQuery;
    meta: BoardMetaResponse | null;
    onchange: (patch: Partial<ListQuery>) => void;
  } = $props();
</script>

<div class="filters">
  <select
    aria-label="Status"
    value={query.status ?? ''}
    onchange={(e) => onchange({ status: (e.currentTarget.value || undefined) as ListQuery['status'] })}
  >
    <option value="">Any status</option>
    {#each meta?.statusOptions ?? [] as s (s)}
      <option value={s}>{s}</option>
    {/each}
  </select>

  <select
    aria-label="Excitement"
    value={query.excitement ?? ''}
    onchange={(e) =>
      onchange({ excitement: (e.currentTarget.value || undefined) as ListQuery['excitement'] })}
  >
    <option value="">Any excitement</option>
    {#each meta?.excitementOptions ?? [] as x (x)}
      <option value={x}>{x}</option>
    {/each}
  </select>

  <input
    aria-label="Company"
    placeholder="Company…"
    value={query.company ?? ''}
    onchange={(e) => onchange({ company: e.currentTarget.value || undefined })}
  />

  <label>
    From
    <input
      type="date"
      value={query.dateFrom ?? ''}
      onchange={(e) => onchange({ dateFrom: e.currentTarget.value || undefined })}
    />
  </label>

  <label>
    To
    <input
      type="date"
      value={query.dateTo ?? ''}
      onchange={(e) => onchange({ dateTo: e.currentTarget.value || undefined })}
    />
  </label>

  <select
    aria-label="Archived"
    value={query.archived ?? 'false'}
    onchange={(e) => onchange({ archived: e.currentTarget.value as 'true' | 'false' })}
  >
    <option value="false">Active</option>
    <option value="true">Archived</option>
  </select>
</div>

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .filters select,
  .filters input {
    font: inherit;
    padding: 0.3rem 0.4rem;
  }

  .filters label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
</style>
