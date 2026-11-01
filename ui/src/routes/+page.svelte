<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { handleApiError } from '$lib/api.js';
  import { showError } from '$lib/errorStore.js';
  import { toolchain } from '$lib/toolchainStore.js';

  interface EnvRef {
    id: string;
    name: string;
  }

  interface Repo {
    id: string;
    name: string;
    type: string;
    createdAt: number;
    envs: EnvRef[];
    packageCount: number;
  }

  const VIEW_KEY = 'repoView';
  const viewFromStorage = (): 'grid' | 'list' => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(VIEW_KEY);
      if (stored === 'grid' || stored === 'list') return stored;
    }
    return 'grid';
  };

  let repos: Repo[] = [];
  let name = '';
  let type = 'pacman';
  let envName = '';
  let loading = true;
  let view = viewFromStorage();

  function switchView(next: 'grid' | 'list') {
    view = next;
    localStorage.setItem(VIEW_KEY, next);
  }

  async function load() {
    const res = await fetch('/api/v1/repos');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message ?? 'load failed');
    repos = json.data;
  }

  async function createRepo() {
    const res = await fetch('/api/v1/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, env: envName.trim() || undefined }),
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('CREATE_FAILED', json);
      return;
    }
    name = '';
    envName = '';
    type = 'pacman';
    await load();
    await goto(resolve(`/repos/${json.data.name}`));
  }

  function typeLabel(name: string, cap: { ok: boolean; missing: string[]; disabledByConfig: boolean } | undefined): string {
    if (!cap) return name;
    if (cap.disabledByConfig) return `${name} (disabled)`;
    if (!cap.ok) return `${name} (unavailable: missing ${cap.missing.join(', ')})`;
    return name;
  }

  onMount(() => {
    load().catch((e) => showError('LOAD_FAILED', String(e))).finally(() => (loading = false));
  });
</script>

<div class="container">
  <div class="d-flex align-items-center justify-content-between gap-3 mb-4">
    <h1 class="mb-0">Repositories</h1>
    <div class="d-flex align-items-center gap-2">
      <div class="btn-group btn-group-sm" role="group" aria-label="View">
        <button type="button" class="btn btn-outline-secondary" class:active={view === 'grid'} on:click={() => switchView('grid')}>
          <i class="bi bi-grid-3x3-gap"></i>
        </button>
        <button type="button" class="btn btn-outline-secondary" class:active={view === 'list'} on:click={() => switchView('list')}>
          <i class="bi bi-list-ul"></i>
        </button>
      </div>
      <span class="badge text-bg-secondary">{repos.length}</span>
    </div>
  </div>

  {#if loading}
    <div class="d-flex align-items-center gap-2 text-body-secondary">
      <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
      Loading…
    </div>
  {:else if view === 'grid'}
    <div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-3 mb-4">
      {#each repos as repo (repo.id)}
        <div class="col">
          <div class="card h-100 shadow-sm">
            <div class="card-body">
              <h5 class="card-title">
                <a href={resolve(`/repos/${repo.name}`)} class="text-decoration-none">{repo.name}</a>
              </h5>
              <p class="mb-2"><span class="badge text-bg-secondary">{repo.type}</span></p>
              <p class="card-text small text-body-secondary mb-0">
                {repo.envs.map((env) => env.name).join(', ')} · {repo.packageCount}
                package{repo.packageCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
        </div>
      {:else}
        <div class="col-12">
          <div class="text-body-secondary">No repositories yet. Create one to get started.</div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="table-responsive mb-4">
      <table class="table table-hover align-middle">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Environments</th>
            <th>Packages</th>
          </tr>
        </thead>
        <tbody>
          {#each repos as repo (repo.id)}
            <tr>
              <td><a href={resolve(`/repos/${repo.name}`)} class="text-decoration-none">{repo.name}</a></td>
              <td><span class="badge text-bg-secondary">{repo.type}</span></td>
              <td class="small">{repo.envs.map((env) => env.name).join(', ')}</td>
              <td>{repo.packageCount}</td>
            </tr>
          {:else}
            <tr><td colspan="4" class="text-body-secondary">No repositories yet. Create one to get started.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="card shadow-sm card-create">
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
        <div class="col-md-3">
          <label for="repo-type" class="form-label">Type</label>
          <select id="repo-type" class="form-select" bind:value={type}>
            {#each Object.entries($toolchain ?? {}) as [name, cap] (name)}
              <option
                value={name}
                disabled={!cap.ok}
                title={!cap.ok ? (cap.disabledByConfig ? `DISABLE_${name.toUpperCase()}=1` : `missing tools: ${cap.missing.join(', ')}`) : undefined}
              >
                {typeLabel(name, cap)}
              </option>
            {:else}
              <option value="pacman">pacman</option>
              <option value="deb">deb</option>
              <option value="rpm">rpm</option>
              <option value="flatpak">flatpak</option>
            {/each}
          </select>
        </div>
        <div class="col-md-3">
          <label for="repo-env" class="form-label">First environment <span class="text-body-secondary small">(optional)</span></label>
          <input
            id="repo-env"
            class="form-control"
            bind:value={envName}
            placeholder="stable"
            pattern="[a-z0-9-]+"
          />
        </div>
        <div class="col-md-2">
          <button type="submit" class="btn btn-primary w-100">Create</button>
        </div>
      </form>
    </div>
  </div>
</div>
