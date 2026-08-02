<script lang="ts">
  import type { BoardProfile } from '../../lib/api/types';

  let {
    profiles,
    current,
    choose,
  }: { profiles: BoardProfile[]; current: string | null; choose: (name: string) => void } =
    $props();
</script>

<label class="profile-switcher">
  <span>Profile</span>
  <select value={current ?? ''} onchange={(e) => choose(e.currentTarget.value)}>
    {#each profiles as p (p.name)}
      <option value={p.name}>{p.name}{p.hasDb ? '' : ' (no local db)'}</option>
    {/each}
  </select>
</label>
