<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { handleApiError } from '$lib/api.js';
  import { showError } from '$lib/errorStore.js';
  import { showNotice } from '$lib/noticeStore.js';
  import { user } from '$lib/userStore.js';
  import { formatBytes } from '$lib/format.js';
  import JobsPanel from '$lib/JobsPanel.svelte';
  import PromotePanel from '$lib/PromotePanel.svelte';

  interface Package {
    filename: string;
    version: string;
    arch: string;
    size: number;
    status: string;
    createdAt: number;
  }

  const repoName = page.params.repo;

  let repoType = 'pacman';
  let envs: { id: string; name: string }[] = [];
  let activeEnv = 'stable';
  let packages: Package[] = [];
  let pkgCount = 0;
  let search = '';
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let branchMode = 'env';
  let savedBranchMode = 'env';
  let savingBranchMode = false;
  let file: FileList | null = null;
  let uploading = false;
  let message = '';
  let snippet = '';
  let snippetCopied = false;
  let activeTab = 'packages';
  let showNewEnv = false;
  let newEnvName = '';

  async function load() {
    const query = search ? `?q=${encodeURIComponent(search)}` : '';
    const [repoRes, pkgRes, snippetRes] = await Promise.all([
      fetch(`/api/v1/repos/${repoName}`),
      fetch(`/api/v1/repos/${repoName}/${activeEnv}/packages${query}`),
      fetch(`/api/v1/repos/${repoName}/${activeEnv}/setup-snippet`),
    ]);
    const repoJson = await repoRes.json();
    const pkgJson = await pkgRes.json();
    const snippetJson = await snippetRes.json();
    if (!repoJson.success) throw new Error(repoJson.error?.message ?? 'repo load failed');
    if (!pkgJson.success) throw new Error(pkgJson.error?.message ?? 'package load failed');
    repoType = repoJson.data.type;
    envs = repoJson.data.envs;
    branchMode = repoJson.data.branchMode ?? 'env';
    savedBranchMode = branchMode;
    packages = pkgJson.data;
    pkgCount = pkgJson.pagination?.total ?? packages.length;
    snippet = snippetJson.success ? snippetJson.data : '';
  }

  function switchEnv(name: string) {
    activeEnv = name;
    message = '';
    search = '';
    clearTimeout(searchTimer);
    load().catch((e) => showError('LOAD_FAILED', String(e)));
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      () => load().catch((e) => showError('LOAD_FAILED', String(e))),
      250,
    );
  }

  async function saveBranchMode() {
    savingBranchMode = true;
    try {
      const res = await fetch(`/api/v1/repos/${repoName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchMode }),
      });
      const json = await res.json();
      if (!json.success) {
        handleApiError('PATCH_REPO_FAILED', json);
        return;
      }
      showNotice('Flatpak branch naming updated; new uploads use the selected setting.');
      await load();
    } finally {
      savingBranchMode = false;
    }
  }

  async function renameEnv(oldName: string) {
    const next = prompt(`Rename environment "${oldName}" to:`, oldName);
    if (!next || next === oldName) return;
    const res = await fetch(`/api/v1/repos/${repoName}/envs/${oldName}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: next }),
    });
    if (!res.ok) {
      handleApiError('RENAME_FAILED', await res.json());
      return;
    }
    if (oldName === activeEnv) activeEnv = next;
    showNotice(`Environment renamed to "${next}".`);
    await load();
  }

  async function deleteEnv(name: string) {
    if (!confirm(`Delete environment "${name}"? Its packages and metadata are gone for good.`)) return;
    const res = await fetch(`/api/v1/repos/${repoName}/envs/${name}`, { method: 'DELETE' });
    if (!res.ok) {
      handleApiError('DELETE_ENV_FAILED', await res.json());
      return;
    }
    if (activeEnv === name) {
      const remaining = envs.find((env) => env.name !== name);
      activeEnv = remaining?.name ?? activeEnv;
    }
    showNotice(`Environment "${name}" deleted.`);
    await load();
  }

  async function deleteRepo() {
    if (!confirm(`Delete repository "${repoName}"? All its environments, packages and keys are gone for good.`)) return;
    const res = await fetch(`/api/v1/repos/${repoName}`, { method: 'DELETE' });
    if (!res.ok) {
      handleApiError('DELETE_FAILED', await res.json());
      return;
    }
    showNotice(`Repository "${repoName}" deleted.`);
    goto(resolve('/'));
  }

  async function createEnv() {    const name = newEnvName.trim();
    if (!name) return;
    const res = await fetch(`/api/v1/repos/${repoName}/envs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('CREATE_ENV_FAILED', json);
      return;
    }
    showNewEnv = false;
    newEnvName = '';
    activeEnv = name;
    await load();
  }

  async function upload() {
    if (!file || file.length === 0) return;
    uploading = true;
    message = '';
    try {
      const res = await fetch(`/api/v1/repos/${repoName}/${activeEnv}/packages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file[0],
      });
      const json = await res.json();
      if (!json.success) {
        handleApiError('UPLOAD_FAILED', json);
        return;
      }
      message = `Uploaded ${json.data.filename}; job ${json.data.jobId}`;
      activeTab = 'jobs';
      await load();
    } catch (e) {
      showError('UPLOAD_FAILED', String(e));
    } finally {
      uploading = false;
      file = null;
    }
  }

  async function deletePkg(filename: string) {
    const res = await fetch(
      `/api/v1/repos/${repoName}/${activeEnv}/packages/${encodeURIComponent(filename)}`,
      {
        method: 'DELETE',
      },
    );
    const json = await res.json();
    if (!json.success) {
      handleApiError('DELETE_FAILED', json);
      return;
    }
    await load();
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      snippetCopied = true;
      setTimeout(() => (snippetCopied = false), 2000);
    } catch {
      showError('COPY_FAILED', 'Could not copy snippet to clipboard');
    }
  }

  onMount(() => {
    load().catch((e) => showError('LOAD_FAILED', String(e)));
  });
</script>

<div class="container">
  <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
    <h1 class="mb-0">{repoName}</h1>
  </div>

  <ul class="nav nav-pills mb-3 align-items-center">
    {#each envs as env}
      <li class="nav-item">
        <button
          class="nav-link"
          class:active={env.name === activeEnv}
          on:click={() => switchEnv(env.name)}
        >
          {env.name}
        </button>
      </li>
    {/each}
    {#if showNewEnv}
      <li class="nav-item ms-2">
        <form class="d-flex gap-1" on:submit|preventDefault={createEnv}>
          <input
            class="form-control form-control-sm"
            style="width: 9rem;"
            placeholder="env name"
            bind:value={newEnvName}
          />
          <button class="btn btn-sm btn-primary" type="submit">Add</button>
          <button class="btn btn-sm btn-outline-secondary" type="button" on:click={() => (showNewEnv = false)}>
            Cancel
          </button>
        </form>
      </li>
    {:else}
      <li class="nav-item ms-2">
        <button class="btn btn-sm btn-outline-secondary" on:click={() => (showNewEnv = true)}>
          <i class="bi bi-plus-lg"></i> New env
        </button>
      </li>
    {/if}
  </ul>

  <ul class="nav nav-tabs mb-3">
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'packages'} on:click={() => (activeTab = 'packages')}>
        Packages {#if pkgCount}<span class="badge text-bg-secondary ms-1">{pkgCount}</span>{/if}
      </button>
    </li>
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'promote'} on:click={() => (activeTab = 'promote')}>Promote</button>
    </li>
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'jobs'} on:click={() => (activeTab = 'jobs')}>Jobs</button>
    </li>
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'setup'} on:click={() => (activeTab = 'setup')}>Setup</button>
    </li>
    {#if $user?.role === 'admin'}
      <li class="nav-item ms-auto">
        <button class="nav-link text-body-secondary" class:active={activeTab === 'settings'} on:click={() => (activeTab = 'settings')}>
          <i class="bi bi-gear"></i> Settings
        </button>
      </li>
    {/if}
  </ul>

  {#if activeTab === 'packages'}
    <div class="card shadow-sm mb-4">
      <div class="card-body">
        <h5 class="card-title">Upload package</h5>
        {#if repoType === 'flatpak'}
          <p class="text-body-secondary">Select a <code>.flatpak</code> bundle.</p>
          <div class="mb-3">
            <input
              class="form-control"
              type="file"
              accept=".flatpak"
              bind:files={file}
            />
          </div>
        {:else if repoType === 'deb'}
          <p class="text-body-secondary">Select a <code>.deb</code> package.</p>
          <div class="mb-3">
            <input
              class="form-control"
              type="file"
              accept=".deb"
              bind:files={file}
            />
          </div>
        {:else if repoType === 'rpm'}
          <p class="text-body-secondary">Select an <code>.rpm</code> package.</p>
          <div class="mb-3">
            <input
              class="form-control"
              type="file"
              accept=".rpm"
              bind:files={file}
            />
          </div>
        {:else}
          <p class="text-body-secondary">Select a <code>.pkg.tar.zst</code> or <code>.pkg.tar.xz</code> file.</p>
          <div class="mb-3">
            <input
              class="form-control"
              type="file"
              accept=".pkg.tar.zst,.pkg.tar.xz"
              bind:files={file}
            />
          </div>
        {/if}
        <button class="btn btn-primary" on:click={upload} disabled={uploading || !file}>
          {#if uploading}
            <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
            Uploading…
          {:else}
            Upload
          {/if}
        </button>
        {#if message}
          <div class="alert alert-success mt-3 mb-0">{message}</div>
        {/if}
      </div>
    </div>

    <div class="card shadow-sm">
      <div class="card-body">
        <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
          <h5 class="card-title mb-0">Packages in {activeEnv}</h5>
          <input
            class="form-control form-control-sm w-auto ms-auto"
            type="search"
            placeholder="Filter by filename…"
            aria-label="Filter packages by filename"
            bind:value={search}
            on:input={onSearchInput}
          />
        </div>
        {#if packages.length > 0}
          <div class="table-responsive">
            <table class="table table-striped table-hover align-middle">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Version</th>
                  <th>Arch</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each packages as pkg}
                  <tr>
                    <td class="text-break">{pkg.filename}</td>
                    <td>{pkg.version ?? '—'}</td>
                    <td>{pkg.arch ?? '—'}</td>
                    <td>{formatBytes(pkg.size)}</td>
                    <td>
                      <span class="badge" class:text-bg-success={pkg.status === 'ready'} class:text-bg-warning={pkg.status !== 'ready'}>{pkg.status}</span>
                    </td>
                    <td>
                      <button class="btn btn-sm btn-outline-danger" aria-label="Delete package" on:click={() => deletePkg(pkg.filename)}>
                        <i class="bi bi-trash"></i>
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-body-secondary mb-0">
            {search ? 'No packages match the filter.' : 'No packages uploaded yet.'}
          </p>
        {/if}
      </div>
    </div>
  {/if}

  {#if activeTab === 'promote'}
    {#key activeEnv}
      <PromotePanel {repoName} {envs} sourceEnv={activeEnv} />
    {/key}
  {/if}

  {#if activeTab === 'jobs'}
    <JobsPanel {repoName} />
  {/if}

  {#if activeTab === 'setup'}
    <div class="card shadow-sm">
      <div class="card-body">
        <h5 class="card-title">Setup</h5>
        {#if repoType === 'flatpak'}
          <p class="text-body-secondary">Run these commands on the client to add the remote and install an app:</p>
        {:else if repoType === 'deb'}
          <p class="text-body-secondary">Run these commands on the client to add the apt repository:</p>
        {:else if repoType === 'rpm'}
          <p class="text-body-secondary">Run these commands on the client to add the dnf repository:</p>
        {:else}
          <p class="text-body-secondary">Add this block to <code>/etc/pacman.conf</code>:</p>
        {/if}
        {#if snippet}
          <div class="position-relative">
            <button class="btn btn-sm btn-outline-secondary position-absolute top-0 end-0 m-2" on:click={copySnippet}>
              {#if snippetCopied}
                <i class="bi bi-check-lg"></i> Copied
              {:else}
                <i class="bi bi-clipboard"></i> Copy
              {/if}
            </button>
            <pre class="p-3 rounded bg-body-tertiary border"><code>{snippet}</code></pre>
          </div>
        {:else}
          <p class="text-body-secondary mb-0">Loading setup snippet…</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if activeTab === 'settings'}
    {#if repoType === 'flatpak'}
      <div class="card shadow-sm mb-4">
        <div class="card-body">
          <h5 class="card-title">Flatpak branch naming</h5>
          <select class="form-select w-auto" bind:value={branchMode} disabled={savingBranchMode} aria-label="Flatpak branch naming">
            <option value="env">Name branches after the environment</option>
            <option value="bundle">Keep the bundle's original branch</option>
          </select>
          <p class="small text-body-secondary mt-2 mb-2">
            Packages already in the repo keep their current branch; after switching, the same app
            can appear under two branch names until the old packages are re-uploaded or removed.
          </p>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            disabled={savingBranchMode || branchMode === savedBranchMode}
            on:click={() => void saveBranchMode()}
          >
            Save
          </button>
        </div>
      </div>
    {/if}
    <div class="card shadow-sm mb-4">
      <div class="card-body">
        <h5 class="card-title">Environment: {activeEnv}</h5>
        <p class="small text-body-secondary">
          The environment name appears in client URLs ({repoName}/{activeEnv}); renaming it means
          clients need updated configuration.
        </p>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" on:click={() => renameEnv(activeEnv)}>
            <i class="bi bi-pencil me-1"></i>Rename
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-danger"
            disabled={envs.length === 1}
            title={envs.length === 1 ? 'the last environment cannot be deleted' : undefined}
            on:click={() => void deleteEnv(activeEnv)}
          >
            <i class="bi bi-trash me-1"></i>Delete
          </button>
        </div>
      </div>
    </div>

    <div class="card border-danger">
      <div class="card-body">
        <h5 class="card-title text-danger">Danger zone</h5>
        <p class="small text-body-secondary">
          Deleting the repository removes every environment, package and GPG key for
          {"\"" + repoName + "\""} permanently. Blocked while rebuild jobs are running.
        </p>
        <button type="button" class="btn btn-sm btn-danger" on:click={() => void deleteRepo()}>
          <i class="bi bi-trash me-1"></i>Delete repository
        </button>
      </div>
    </div>
  {/if}
</div>
