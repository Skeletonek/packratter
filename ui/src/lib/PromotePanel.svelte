<script lang="ts">
  import { onMount } from 'svelte';
  import { handleApiError } from '$lib/api.js';
  import { showError } from '$lib/errorStore.js';
  import { formatBytes } from '$lib/format.js';

  export let repoName: string;
  export let sourceEnv: string;
  export let envs: { id: string; name: string }[];

  interface Pkg {
    filename: string;
    version: string | null;
    arch: string | null;
    size: number;
  }

  let targetEnv = '';
  let onlyInFrom: Pkg[] = [];
  let onlyInTo: Pkg[] = [];
  let different: Pkg[] = [];
  let selected = new Set<string>();
  let promoting = false;
  let result = '';

  function targets(): { id: string; name: string }[] {
    return envs.filter((e) => e.name !== sourceEnv);
  }

  async function loadDiff() {
    if (!targetEnv) return;
    const res = await fetch(`/api/v1/repos/${repoName}/diff?from=${sourceEnv}&to=${targetEnv}`);
    const json = await res.json();
    if (!json.success) {
      handleApiError('DIFF_FAILED', json);
      return;
    }
    onlyInFrom = json.data.onlyInFrom;
    onlyInTo = json.data.onlyInTo;
    different = json.data.different;
    selected = new Set(onlyInFrom.map((p: Pkg) => p.filename));
  }

  function toggle(filename: string) {
    if (selected.has(filename)) selected.delete(filename);
    else selected.add(filename);
    selected = selected;
  }

  async function promote(useSelection: boolean) {
    promoting = true;
    result = '';
    try {
      const filenames = useSelection ? [...selected] : undefined;
      const res = await fetch(`/api/v1/repos/${repoName}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sourceEnv, to: targetEnv, filenames }),
      });
      const json = await res.json();
      if (!json.success) {
        handleApiError('PROMOTE_FAILED', json);
        return;
      }
      const { jobId, promoted, skipped } = json.data;
      result = `Promoted ${promoted}, skipped ${skipped}.`;
      if (jobId) {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const jobRes = await fetch(`/api/v1/jobs/${jobId}`);
          const jobJson = await jobRes.json();
          if (!jobJson.success) continue;
          if (jobJson.data.status === 'done') {
            result += ' Rebuild finished.';
            break;
          }
          if (jobJson.data.status === 'error') {
            showError('REBUILD_ERROR', jobJson.data.log || 'rebuild failed');
            break;
          }
        }
      }
      await loadDiff();
    } catch (e) {
      showError('PROMOTE_FAILED', String(e));
    } finally {
      promoting = false;
    }
  }

  onMount(() => {
    const available = targets();
    targetEnv = available.some((e) => e.name === 'stable')
      ? 'stable'
      : (available[0]?.name ?? '');
    loadDiff().catch(() => {});
  });
</script>

<div class="card shadow-sm">
  <div class="card-body">
    <h5 class="card-title">Promote</h5>
    {#if targets().length === 0}
      <p class="text-body-secondary mb-0">Create another env to promote packages into.</p>
    {:else}
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <span class="text-body-secondary">Promote from</span>
        <span class="badge text-bg-secondary">{sourceEnv}</span>
        <i class="bi bi-arrow-right"></i>
        <select class="form-select form-select-sm w-auto" bind:value={targetEnv} on:change={loadDiff}>
          {#each targets() as env}
            <option value={env.name}>{env.name}</option>
          {/each}
        </select>
      </div>

      {#if onlyInFrom.length > 0}
        <div class="table-responsive">
          <table class="table table-striped table-hover align-middle">
            <thead>
              <tr>
                <th></th>
                <th>Filename</th>
                <th>Version</th>
                <th>Arch</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {#each onlyInFrom as pkg}
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(pkg.filename)}
                      on:change={() => toggle(pkg.filename)}
                    />
                  </td>
                  <td class="text-break">{pkg.filename}</td>
                  <td>{pkg.version ?? '—'}</td>
                  <td>{pkg.arch ?? '—'}</td>
                  <td>{formatBytes(pkg.size)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="d-flex flex-wrap gap-2">
          <button
            class="btn btn-primary"
            disabled={promoting || selected.size === 0}
            on:click={() => promote(true)}
          >
            Promote selected ({selected.size})
          </button>
          <button class="btn btn-outline-primary" disabled={promoting} on:click={() => promote(false)}>
            Promote all
          </button>
        </div>
      {:else}
        <p class="text-body-secondary mb-0">
          Nothing to promote — {sourceEnv} has no packages missing from {targetEnv}.
        </p>
      {/if}

      {#if different.length > 0}
        <div class="alert alert-warning mt-3 mb-0">
          Same filename but different content in {targetEnv} (skipped by promote):
          {different.map((p) => p.filename).join(', ')}
        </div>
      {/if}
      {#if onlyInTo.length > 0}
        <p class="small text-body-secondary mt-2 mb-0">
          {onlyInTo.length} package(s) exist only in {targetEnv}.
        </p>
      {/if}
      {#if result}
        <div class="alert alert-success mt-3 mb-0">{result}</div>
      {/if}
    {/if}
  </div>
</div>
