<script lang="ts">
  import type { BoardJobRow } from '../../lib/api/types';

  let {
    rows,
    sort,
    order,
    onsort,
    onselect,
  }: {
    rows: BoardJobRow[];
    sort: 'date_found' | 'score';
    order: 'asc' | 'desc';
    onsort: (col: 'date_found' | 'score') => void;
    onselect: (id: string) => void;
  } = $props();

  function arrow(col: 'date_found' | 'score'): string {
    if (col !== sort) return '';
    return order === 'asc' ? ' ↑' : ' ↓';
  }
</script>

<table class="jobs">
  <thead>
    <tr>
      <th><button type="button" onclick={() => onsort('date_found')}>Found{arrow('date_found')}</button></th>
      <th>Title</th>
      <th>Company</th>
      <th>Location</th>
      <th><button type="button" onclick={() => onsort('score')}>Score{arrow('score')}</button></th>
      <th>Excitement</th>
      <th>Status</th>
      <th>Flags</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.id)}
      <tr class:archived={row.archived}>
        <td>{row.dateFound.slice(0, 10)}</td>
        <td class="title">
          <button type="button" class="link" onclick={() => onselect(row.id)}>{row.title}</button>
        </td>
        <td>{row.company}</td>
        <td>{row.locationCity ?? '—'}{row.workType ? ` · ${row.workType}` : ''}</td>
        <td class="num">{row.score ?? '—'}</td>
        <td>{row.excitement ?? '—'}</td>
        <td>{row.tracking?.status ?? '—'}</td>
        <td>{row.reviewFlags.length > 0 ? `⚑ ${row.reviewFlags.length}` : ''}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .jobs {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  .jobs th,
  .jobs td {
    text-align: left;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .jobs td.title {
    white-space: normal;
  }

  .jobs th button {
    font: inherit;
    font-weight: 600;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
  }

  .jobs .num {
    text-align: right;
  }

  .link {
    font: inherit;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  tr.archived {
    opacity: 0.55;
  }
</style>
