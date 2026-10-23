<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { showError } from '$lib/errorStore.js';

  interface Package {
    filename: string;
    version: string;
    arch: string;
    size: number;
    status: string;
    createdAt: number;
  }

  interface Job {
    id: string;
    status: string;
    log: string;
  }

  const repoId = page.params.repo;

  let repoName = '';
  let repoType = 'pacman';
  let envId = '';
  let packages: Package[] = [];
  let jobs: Job[] = [];
  let file: FileList | null = null;
  let uploading = false;
  let message = '';
  let snippet = '';
  let snippetCopied = false;
  let activeTab = 'upload';

  function handleApiError(prefix: string, json: { error?: { code?: string; message?: string } }) {
    showError(json.error?.code ?? prefix, json.error?.message ?? 'Unexpected server response');
  }

  function formatBytes(n: number): string {
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log10(n) / 3);
    const value = n / Math.pow(1000, i);
    return `${value.toFixed(1)} ${units[i]}`;
  }

  async function load() {
    const [repoRes, pkgRes, snippetRes] = await Promise.all([
      fetch(`/api/v1/repos/${repoId}`),
      fetch(`/api/v1/repos/${repoId}/stable/packages`),
      fetch(`/api/v1/repos/${repoId}/stable/setup-snippet`),
    ]);
    const repoJson = await repoRes.json();
    const pkgJson = await pkgRes.json();
    const snippetJson = await snippetRes.json();
    if (!repoJson.success) throw new Error(repoJson.error?.message ?? 'repo load failed');
    if (!pkgJson.success) throw new Error(pkgJson.error?.message ?? 'package load failed');
    repoName = repoJson.data.name;
    repoType = repoJson.data.type;
    envId = repoJson.data.envs[0]?.id ?? '';
    packages = pkgJson.data;
    snippet = snippetJson.success ? snippetJson.data : '';
  }

  async function upload() {
    if (!file || file.length === 0) return;
    uploading = true;
    message = '';
    try {
      const res = await fetch(`/api/v1/repos/${repoId}/stable/packages`, {
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
      pollJob(json.data.jobId);
      await load();
    } catch (e) {
      showError('UPLOAD_FAILED', String(e));
    } finally {
      uploading = false;
      file = null;
    }
  }

  async function pollJob(jobId: string) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`/api/v1/jobs/${jobId}`);
      const json = await res.json();
      if (!json.success) continue;
      jobs = [...jobs.filter((j) => j.id !== jobId), json.data];
      if (json.data.status === 'error') {
        showError('REBUILD_ERROR', json.data.log || 'rebuild failed');
        break;
      }
      if (json.data.status === 'done') break;
    }
  }

  async function deletePkg(filename: string) {
    const res = await fetch(`/api/v1/repos/${repoId}/stable/packages/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('DELETE_FAILED', json);
      return;
    }
    pollJob(json.data.jobId);
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
  <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
    <h1 class="mb-0">{repoName || 'Repository'}</h1>
    {#if envId}
      <span class="badge text-bg-secondary font-monospace text-truncate" style="max-width: 16rem;" title={envId}>{envId}</span>
    {/if}
  </div>

  <ul class="nav nav-tabs mb-3">
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'upload'} on:click={() => (activeTab = 'upload')}>Upload</button>
    </li>
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'packages'} on:click={() => (activeTab = 'packages')}>
        Packages {#if packages.length}<span class="badge text-bg-secondary ms-1">{packages.length}</span>{/if}
      </button>
    </li>
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'jobs'} on:click={() => (activeTab = 'jobs')}>
        Jobs {#if jobs.length}<span class="badge text-bg-secondary ms-1">{jobs.length}</span>{/if}
      </button>
    </li>
    <li class="nav-item">
      <button class="nav-link" class:active={activeTab === 'setup'} on:click={() => (activeTab = 'setup')}>Setup</button>
    </li>
  </ul>

  {#if activeTab === 'upload'}
    <div class="card shadow-sm">
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
  {/if}

  {#if activeTab === 'packages'}
    <div class="card shadow-sm">
      <div class="card-body">
        <h5 class="card-title">Packages</h5>
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
          <p class="text-body-secondary mb-0">No packages uploaded yet.</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if activeTab === 'jobs'}
    <div class="card shadow-sm">
      <div class="card-body">
        <h5 class="card-title">Jobs</h5>
        {#if jobs.length > 0}
          <div class="list-group">
            {#each jobs.slice().reverse() as job}
              <div class="list-group-item">
                <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
                  <code class="small text-truncate" style="max-width: 16rem;">{job.id}</code>
                  <span
                    class="badge"
                    class:text-bg-success={job.status === 'done'}
                    class:text-bg-danger={job.status === 'error'}
                    class:text-bg-warning={job.status !== 'done' && job.status !== 'error'}
                  >
                    {job.status}
                  </span>
                </div>
                {#if job.log}
                  <details class="mt-2">
                    <summary class="small user-select-none">Show log</summary>
                    <pre class="mt-2 p-2 rounded bg-body-tertiary border small mb-0"><code>{job.log}</code></pre>
                  </details>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-body-secondary mb-0">No jobs yet.</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if activeTab === 'setup'}
    <div class="card shadow-sm">
      <div class="card-body">
        <h5 class="card-title">Setup</h5>
        {#if repoType === 'flatpak'}
          <p class="text-body-secondary">Run these commands on the client to add the remote and install an app:</p>
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
</div>
