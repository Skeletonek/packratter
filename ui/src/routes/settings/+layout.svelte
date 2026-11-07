<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user } from '$lib/userStore.js';

  interface Tab {
    path: string;
    label: string;
    icon: string;
  }

  const tabs: Tab[] = [
    { path: '/settings', label: 'Global', icon: 'bi-sliders' },
    { path: '/settings/users', label: 'Users', icon: 'bi-people' },
    { path: '/settings/authentication', label: 'Authentication', icon: 'bi-shield-lock' },
    { path: '/settings/keys', label: 'Keys', icon: 'bi-key' },
    { path: '/settings/audit', label: 'Audit', icon: 'bi-journal-text' },
  ];

  function isActive(tab: Tab): boolean {
    const current = page.url.pathname.replace(/\/+$/, '') || '/';
    return current === tab.path;
  }

  onMount(() => {
    if ($user?.role !== 'admin') {
      goto(resolve('/'));
    }
  });
</script>

<div class="container">
  <h1 class="h4 mb-3">Settings</h1>

  {#if $user?.role === 'admin'}
    <ul class="nav nav-pills mb-4 flex-wrap">
      {#each tabs as tab (tab.path)}
        <li class="nav-item">
          <a
            class="nav-link"
            class:active={isActive(tab)}
            href={resolve(tab.path)}
            aria-current={isActive(tab) ? 'page' : undefined}
          >
            <i class="bi {tab.icon} me-1"></i>{tab.label}
          </a>
        </li>
      {/each}
    </ul>
    <slot />
  {:else}
    <p class="text-body-secondary">Admin access required.</p>
  {/if}
</div>
