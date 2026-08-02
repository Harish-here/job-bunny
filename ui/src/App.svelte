<script lang="ts">
  import { onMount } from 'svelte';
  import { getJson } from './lib/api/client';
  import type { ProfilesResponse } from './lib/api/types';
  import { createProfileStore } from './lib/profile';
  import { createRouter } from './lib/router';
  import AnalyticsPage from './features/analytics/AnalyticsPage.svelte';
  import BoardPage from './features/board/BoardPage.svelte';
  import OnboardingPage from './features/onboarding/OnboardingPage.svelte';
  import ProfileSwitcher from './features/shell/ProfileSwitcher.svelte';
  import Sidebar from './features/shell/Sidebar.svelte';

  const router = createRouter(window);
  const route = router.route;
  const profileStore = createProfileStore(localStorage);
  const current = profileStore.current;

  let profiles = $state<ProfilesResponse['profiles']>([]);
  let loadError = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await getJson<ProfilesResponse>('/api/profiles');
      profiles = res.profiles;
      profileStore.init(res.profiles);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<div class="shell">
  <Sidebar route={$route} navigate={router.navigate}>
    <ProfileSwitcher {profiles} current={$current} choose={profileStore.choose} />
  </Sidebar>
  <main>
    {#if loadError}
      <p class="error">Could not load profiles: {loadError}</p>
    {:else if $route === 'board'}
      {#if $current}
        <BoardPage profile={$current} />
      {:else}
        <p>No profiles found — create one with the /setup wizard.</p>
      {/if}
    {:else if $route === 'analytics'}
      <AnalyticsPage />
    {:else}
      <OnboardingPage />
    {/if}
  </main>
</div>
