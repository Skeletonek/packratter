<script lang="ts">
  import { onMount } from 'svelte';
  import { handleApiError } from '$lib/api.js';

  interface EnvSetting {
    key: string;
    value: string | null;
    configured: boolean;
    secret: boolean;
  }

  let entries: EnvSetting[] = [];
  let loaded = false;

  onMount(async () => {
    const res = await fetch('/api/v1/settings/env');
    if (res.ok) {
      entries = (await res.json()).data;
      loaded = true;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  });
</script>

<div class="card shadow-sm">
  <div class="card-body">
    <h5 class="card-title">Environment settings</h5>
    <p class="small text-body-secondary">
      These values come from environment variables (or their defaults) at startup.
      Change the compose environment or <code>.env</code> and restart to apply — they
      cannot be edited here.
    </p>
    {#if loaded}
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th class="small text-body-secondary" style="width: 14rem;">Variable</th>
            <th class="small text-body-secondary">Value</th>
          </tr>
        </thead>
        <tbody>
          {#each entries as entry (entry.key)}
            <tr>
              <td><code class="small">{entry.key}</code></td>
              <td>
                {#if entry.secret}
                  {#if entry.configured}
                    <span class="badge text-bg-secondary">set</span>
                    <span class="small text-body-secondary ms-1">(hidden)</span>
                  {:else}
                    <span class="small text-body-secondary">not set</span>
                  {/if}
                {:else}
                  <input
                    class="form-control form-control-sm font-monospace"
                    style="max-width: 24rem;"
                    value={entry.value ?? ''}
                    disabled
                    aria-label="{entry.key} (read-only)"
                  />
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="small text-body-secondary mb-0">Loading…</p>
    {/if}
  </div>
</div>
