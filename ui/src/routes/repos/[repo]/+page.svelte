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
  let envId = '';
  let packages: Package[] = [];
  let jobs: Job[] = [];
  let file: FileList | null = null;
  let uploading = false;
  let message = '';
  let snippet = '';

  function handleApiError(prefix: string, json: { error?: { code?: string; message?: string } }) {
    showError(json.error?.code ?? prefix, json.error?.message ?? 'Unexpected server response');
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
    envId = repoJson.data.envs[0]?.id ?? '';
    packages = pkgJson.data;
    snippet = snippetJson.success ? snippetJson.data : '';
  }

  async function loadJobs() {
    // jobs are not listed by repo; poll known job ids later if needed
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
      pollJob(json.data.jobId);
      await load();
    } catch (e) {
      showError('UPLOAD_FAILED', String(e));
    } finally {
      uploading = false;
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

  onMount(() => {
    load().catch((e) => showError('LOAD_FAILED', String(e)));
  });
</script>

<h1>{repoName}</h1>

<h2>Upload package</h2>
<input type="file" accept=".pkg.tar.zst,.pkg.tar.xz" bind:files={file} />
<button on:click={upload} disabled={uploading || !file}>{uploading ? 'Uploading…' : 'Upload'}</button>
{#if message}<p style="color: green">{message}</p>{/if}

<h2>Packages</h2>
<ul>
  {#each packages as pkg}
    <li>
      {pkg.filename} ({pkg.version}, {pkg.arch}, {pkg.size} bytes, {pkg.status})
      <button on:click={() => deletePkg(pkg.filename)}>Delete</button>
    </li>
  {:else}
    <li>No packages.</li>
  {/each}
</ul>

<h2>Jobs</h2>
<ul>
  {#each jobs.slice().reverse() as job}
    <li>
      {job.id}: {job.status}
      {#if job.status === 'error' || job.status === 'done'}
        <pre>{job.log}</pre>
      {/if}
    </li>
  {:else}
    <li>No jobs yet.</li>
  {/each}
</ul>

<h2>Setup</h2>
{#if snippet}
  <pre>{snippet}</pre>
{:else if repoName}
  <p>Loading setup snippet…</p>
{/if}
