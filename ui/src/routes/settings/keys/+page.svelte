<script lang="ts">
  import { onMount } from 'svelte';
  import { handleApiError } from '$lib/api.js';
  import { formatDate } from '$lib/format.js';

  interface KeyRow {
    repo: string;
    repoType: string;
    fingerprint: string;
    active: boolean;
    algorithm: string | null;
    createdAt: number;
    publicKey: string;
  }

  let keys: KeyRow[] = [];
  let loaded = false;
  let copied: string | null = null;
  let replacing: string | null = null;
  let privateKey = '';
  let passphrase = '';

  onMount(() => void load());

  async function load() {
    const res = await fetch('/api/v1/settings/keys');
    if (res.ok) {
      keys = (await res.json()).data;
      loaded = true;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  }

  function copyPublic(key: KeyRow) {
    void navigator.clipboard?.writeText(key.publicKey);
    copied = key.fingerprint;
    setTimeout(() => (copied = null), 2000);
  }

  function download(key: KeyRow) {
    const url = URL.createObjectURL(new Blob([key.publicKey], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${key.repo}-${key.fingerprint.slice(-8)}.asc`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function startReplace(repo: string) {
    replacing = replacing === repo ? null : repo;
    privateKey = '';
    passphrase = '';
  }

  async function confirmReplace(repo: string) {
    const res = await fetch(`/api/v1/repos/${repo}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        privateKey: privateKey.trim(),
        passphrase: passphrase || undefined,
      }),
    });
    const json = await res.json();
    if (!json.success) {
      handleApiError('KEY_IMPORT_FAILED', json);
      return;
    }
    replacing = null;
    privateKey = '';
    passphrase = '';
    await load();
  }
</script>

<div class="card shadow-sm">
  <div class="card-body">
    <h5 class="card-title">GPG keys</h5>
    <p class="small text-body-secondary mb-3">
      One signing key per repository. Clients install it through the setup snippet;
      give the public key to users who need it another way. Replaced keys stay
      downloadable so clients can transition at their own pace.
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
              <th class="small text-body-secondary">Status</th>
              <th class="small text-body-secondary">Algorithm</th>
              <th class="small text-body-secondary">Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each keys as key (key.fingerprint)}
              <tr>
                <td>
                  {key.repo}
                  <span class="badge text-bg-secondary ms-1">{key.repoType}</span>
                </td>
                <td><code class="small">{key.fingerprint}</code></td>
                <td>
                  {#if key.active}
                    <span class="badge text-bg-success">signing</span>
                  {:else}
                    <span class="badge text-bg-secondary">replaced</span>
                  {/if}
                </td>
                <td class="small">{key.algorithm ?? '—'}</td>
                <td class="small">{formatDate(key.createdAt)}</td>
                <td class="text-end text-nowrap">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary me-1"
                    on:click={() => copyPublic(key)}
                  >
                    {copied === key.fingerprint ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    title="Download the armored public key"
                    on:click={() => download(key)}
                  >
                    <i class="bi bi-download"></i>
                  </button>
                  {#if key.active}
                    <button
                      type="button"
                      class="btn btn-sm btn-outline-primary ms-1"
                      on:click={() => startReplace(key.repo)}
                    >
                      Replace
                    </button>
                  {/if}
                </td>
              </tr>
              {#if replacing === key.repo && key.active}
                <tr>
                  <td colspan="6" class="bg-body-tertiary">
                    <div class="p-2">
                      <p class="small text-warning mb-2">
                        <i class="bi bi-exclamation-triangle me-1"></i>
                        Metadata will be re-signed with the new key. Clients pinned to the
                        old key must install the new one; the old public key stays
                        downloadable here.
                      </p>
                      <textarea
                        class="form-control form-control-sm font-monospace mb-2"
                        rows="4"
                        bind:value={privateKey}
                        placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                      ></textarea>
                      <div class="d-flex gap-2 align-items-center">
                        <input
                          class="form-control form-control-sm"
                          type="password"
                          style="max-width: 260px"
                          bind:value={passphrase}
                          placeholder="Key passphrase (if any)"
                          autocomplete="new-password"
                        />
                        <button
                          type="button"
                          class="btn btn-sm btn-primary"
                          disabled={!privateKey.trim()}
                          on:click={() => void confirmReplace(key.repo)}
                        >
                          Import and re-sign
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-outline-secondary"
                          on:click={() => (replacing = null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    {:else}
      <p class="small text-body-secondary mb-0">Loading…</p>
    {/if}
  </div>
</div>
