<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { authHeaders, handleApiError } from '$lib/api.js';
  import { showError } from '$lib/errorStore.js';

  interface Repo {
    id: string;
    name: string;
    type: string;
    createdAt: number;
  }

  let repos: Repo[] = [];
  let name = '';
  let type = 'pacman';
  let loading = true;

  async function load() {
    const res = await fetch('/api/v1/repos');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message ?? 'load failed');
    repos = json.data;
  }

  async function createRepo() {
    const res = await fetch('/api/v1/repos', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type }),
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('CREATE_FAILED', json);
      return;
    }
    name = '';
    type = 'pacman';
    await load();
    await goto(resolve(`/repos/${json.data.name}`));
  }

  onMount(() => {
    load().catch((e) => showError('LOAD_FAILED', String(e))).finally(() => (loading = false));
  });
</script>

<div class="container">
  <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
    <h1 class="mb-0">Repositories</h1>
    <span class="badge text-bg-secondary">{repos.length}</span>
  </div>

  {#if loading}
    <div class="d-flex align-items-center gap-2 text-body-secondary">
      <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
      Loading…
    </div>
  {:else}
    <div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-3 mb-4">
      {#each repos as repo}
        <div class="col">
          <a href={resolve(`/repos/${repo.name}`)} class="card text-decoration-none h-100 shadow-sm">
            <div class="card-body">
              <h5 class="card-title">{repo.name}</h5>
              <p class="card-text text-body-secondary">{repo.type}</p>
            </div>
          </a>
        </div>
      {:else}
        <div class="col-12">
          <div class="text-body-secondary">No repositories yet. Create one to get started.</div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="card shadow-sm">
    <div class="card-body">
      <h5 class="card-title">Create repository</h5>
      <form on:submit|preventDefault={createRepo} class="row g-2 align-items-end">
        <div class="col-md-4">
          <label for="repo-name" class="form-label">Name</label>
          <input
            id="repo-name"
            class="form-control"
            bind:value={name}
            placeholder="repo-name"
            required
            pattern="[a-z0-9-]+"
          />
        </div>
        <div class="col-md-4">
          <label for="repo-type" class="form-label">Type</label>
          <select id="repo-type" class="form-select" bind:value={type}>
            <option value="pacman">pacman</option>
            <option value="deb">deb</option>
            <option value="rpm">rpm</option>
            <option value="flatpak">flatpak</option>
          </select>
        </div>
        <div class="col-md-3">
          <button type="submit" class="btn btn-primary w-100">Create</button>
        </div>
      </form>
    </div>
  </div>
</div>
