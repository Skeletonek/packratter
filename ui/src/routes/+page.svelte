<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { showError } from '$lib/errorStore.js';

  interface Repo {
    id: string;
    name: string;
    type: string;
    createdAt: number;
  }

  let repos: Repo[] = [];
  let name = '';
  let loading = true;

  async function load() {
    const res = await fetch('/api/v1/repos');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message ?? 'load failed');
    repos = json.data;
  }

  function handleApiError(prefix: string, json: { error?: { code?: string; message?: string } }) {
    showError(json.error?.code ?? prefix, json.error?.message ?? 'Unexpected server response');
  }

  async function createRepo() {
    const res = await fetch('/api/v1/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'pacman' }),
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('CREATE_FAILED', json);
      return;
    }
    name = '';
    await load();
    goto(resolve(`/repos/${json.data.id}`));
  }

  onMount(() => {
    load().catch((e) => showError('LOAD_FAILED', String(e))).finally(() => (loading = false));
  });
</script>

<h1>Repositories</h1>

{#if loading}
  <p>Loading…</p>
{:else}
  <ul>
    {#each repos as repo}
      <li><a href="{resolve(`/repos/${repo.id}`)}">{repo.name}</a> ({repo.type})</li>
    {:else}
      <li>No repositories yet.</li>
    {/each}
  </ul>
{/if}

<h2>Create pacman repo</h2>
<form on:submit|preventDefault={createRepo}>
  <input bind:value={name} placeholder="repo-name" required pattern="[a-z0-9-]+" />
  <button type="submit">Create</button>
</form>
