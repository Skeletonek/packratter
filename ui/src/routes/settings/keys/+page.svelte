<script lang="ts">
  import { onMount } from 'svelte';
  import { handleApiError } from '$lib/api.js';
  import { formatDate } from '$lib/format.js';

  interface KeyRow {
    repo: string;
    repoType: string;
    fingerprint: string;
    algorithm: string | null;
    createdAt: number;
    publicKey: string;
  }

  let keys: KeyRow[] = [];
  let loaded = false;
  let copied: string | null = null;

  onMount(async () => {
    const res = await fetch('/api/v1/settings/keys');
    if (res.ok) {
      keys = (await res.json()).data;
      loaded = true;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  });

  function copyPublic(key: KeyRow) {
    void navigator.clipboard?.writeText(key.publicKey);
    copied = key.repo;
    setTimeout(() => (copied = null), 2000);
  }

  function download(key: KeyRow) {
    const url = URL.createObjectURL(new Blob([key.publicKey], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${key.repo}-public-key.asc`;
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="card shadow-sm">
  <div class="card-body">
    <h5 class="card-title">GPG keys</h5>
    <p class="small text-body-secondary mb-3">
      One signing key per repository. Clients install it through the setup snippet;
      give the public key to users who need it another way. Key rotation isn't
      available yet.
    </p>
    {#if loaded}
      {#if keys.length === 0}
        <p class="small text-body-secondary mb-0">
          No keys yet — every repository gets one when it is created.
        </p>
      {:else}
        <table class="table table-sm align-middle mb-0">
          <thead>
            <tr>
              <th class="small text-body-secondary">Repository</th>
              <th class="small text-body-secondary">Fingerprint</th>
              <th class="small text-body-secondary">Algorithm</th>
              <th class="small text-body-secondary">Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each keys as key (key.repo)}
              <tr>
                <td>
                  {key.repo}
                  <span class="badge text-bg-secondary ms-1">{key.repoType}</span>
                </td>
                <td><code class="small">{key.fingerprint}</code></td>
                <td class="small">{key.algorithm ?? '—'}</td>
                <td class="small">{formatDate(key.createdAt)}</td>
                <td class="text-end text-nowrap">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary me-1"
                    on:click={() => copyPublic(key)}
                  >
                    {copied === key.repo ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    title="Download the armored public key"
                    on:click={() => download(key)}
                  >
                    <i class="bi bi-download"></i>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else}
      <p class="small text-body-secondary mb-0">Loading…</p>
    {/if}
  </div>
</div>
