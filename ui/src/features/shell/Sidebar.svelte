<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { RouteName } from '../../lib/router';

  let {
    route,
    navigate,
    children,
  }: { route: RouteName; navigate: (to: RouteName) => void; children?: Snippet } = $props();

  const items: { name: RouteName; label: string }[] = [
    { name: 'board', label: 'Board' },
    { name: 'analytics', label: 'Analytics' },
    { name: 'onboarding', label: 'Onboarding' },
  ];
</script>

<aside class="sidebar">
  <div class="brand">🐇 Job Bunny</div>
  {@render children?.()}
  <nav>
    {#each items as item (item.name)}
      <button
        type="button"
        class="nav-item"
        class:active={route === item.name}
        onclick={() => navigate(item.name)}
      >
        {item.label}
      </button>
    {/each}
  </nav>
</aside>
