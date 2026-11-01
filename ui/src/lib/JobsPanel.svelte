<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { authHeaders, handleApiError } from '$lib/api.js';

  export let repoName: string;

  interface Job {
    id: string;
    status: string;
    log: string;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: number;
  }

  let jobs: Job[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    const res = await fetch(`/api/v1/jobs?repo=${repoName}`);
    const json = await res.json();
    if (!json.success) {
      handleApiError('JOBS_FAILED', json);
      return;
    }
    jobs = json.data;
    const active = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (active && !timer) {
      timer = setInterval(() => void load(), 1500);
    } else if (!active && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function retry(jobId: string) {
    const res = await fetch(`/api/v1/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('RETRY_FAILED', json);
      return;
    }
    await load();
  }

  onMount(() => {
    load().catch(() => {});
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<div class="card shadow-sm">
  <div class="card-body">
    <h5 class="card-title">Jobs</h5>
    {#if jobs.length > 0}
      <div class="list-group">
        {#each jobs as job}
          <div class="list-group-item">
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
              <code class="small text-truncate" style="max-width: 16rem;">{job.id}</code>
              <div class="d-flex align-items-center gap-2">
                <span
                  class="badge"
                  class:text-bg-success={job.status === 'done'}
                  class:text-bg-danger={job.status === 'error'}
                  class:text-bg-warning={job.status !== 'done' && job.status !== 'error'}
                >
                  {job.status}
                </span>
                {#if job.status === 'done' || job.status === 'error'}
                  <button class="btn btn-sm btn-outline-secondary" on:click={() => retry(job.id)}>
                    <i class="bi bi-arrow-clockwise"></i> Retry
                  </button>
                {/if}
              </div>
            </div>
            {#if job.errorMessage}
              <div class="alert alert-danger py-1 px-2 mt-2 mb-0 small">
                <code>{job.errorCode ?? 'ERROR'}</code> {job.errorMessage}
              </div>
            {/if}
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
