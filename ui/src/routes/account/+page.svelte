<script lang="ts">
  import { onMount } from 'svelte';
  import { type UserInfo, handleApiError } from '$lib/api.js';
  import { setUser } from '$lib/userStore.js';

  interface ApiKey {
    id: string;
    prefix: string;
    createdAt: number;
  }

  let login: string = '';
  let displayName: string = '';
  let email: string = '';
  let hasPassword = true;
  let profileSaved = false;
  let currentPassword = '';
  let nextPassword = '';
  let passwordSaved = false;
  let keys: ApiKey[] = [];
  let newKey: string | null = null;
  let creating = false;

  onMount(async () => {
    const res = await fetch('/api/v1/me');
    if (res.ok) {
      const me: UserInfo = (await res.json()).data;
      login = me.login;
      displayName = me.displayName ?? '';
      email = me.email ?? '';
      hasPassword = me.hasPassword !== false;
      setUser(me);
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
    await loadKeys();
  });

  async function loadKeys() {
    const res = await fetch('/api/v1/keys');
    if (res.ok) {
      keys = (await res.json()).data;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  }

  async function saveProfile() {
    profileSaved = false;
    const res = await fetch('/api/v1/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, displayName, email }),
    });
    if (res.ok) {
      profileSaved = true;
      // server echo keeps the store and the form in sync (trimmed/normalized)
      const json = await res.json();
      const me = json.data as UserInfo;
      login = me.login;
      displayName = me.displayName ?? '';
      email = me.email ?? '';
      setUser(me);
    } else {
      handleApiError('PROFILE_REJECTED', await res.json());
    }
  }

  async function changePassword() {
    passwordSaved = false;
    const res = await fetch('/api/v1/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: currentPassword, next: nextPassword }),
    });
    if (res.ok) {
      passwordSaved = true;
      currentPassword = '';
      nextPassword = '';
    } else {
      handleApiError('PASSWORD_REJECTED', await res.json());
    }
  }

  async function createKey() {
    creating = true;
    try {
      const res = await fetch('/api/v1/keys', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        newKey = json.data.token;
        await loadKeys();
      } else {
        handleApiError('KEY_REJECTED', json);
      }
    } finally {
      creating = false;
    }
  }

  async function revokeKey(id: string) {
    const res = await fetch(`/api/v1/keys/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      handleApiError('KEY_REVOKE_FAILED', await res.json());
    }
    await loadKeys();
  }
</script>

<div class="container">
  <h1 class="h4 mb-3">Account</h1>

  <div class="card mb-3">
    <div class="card-body">
      <h2 class="h6 text-body-secondary">Profile</h2>
      <form
        on:submit={(e) => {
          e.preventDefault();
          void saveProfile();
        }}
      >
        <div class="row g-2 mb-2">
          <div class="col-12 col-sm-4">
            <label for="login" class="form-label small mb-0">Login</label>
            <input id="login" class="form-control form-control-sm" bind:value={login} />
          </div>
          <div class="col-12 col-sm-4">
            <label for="display-name" class="form-label small mb-0">Display name</label>
            <input
              id="display-name"
              class="form-control form-control-sm"
              bind:value={displayName}
              placeholder="shown in the top bar"
            />
          </div>
          <div class="col-12 col-sm-4">
            <label for="email" class="form-label small mb-0">Email</label>
            <input
              id="email"
              class="form-control form-control-sm"
              type="text"
              bind:value={email}
              placeholder="you@example.com"
            />
          </div>
        </div>
        <button type="submit" class="btn btn-sm btn-outline-primary">Save profile</button>
      </form>
      {#if profileSaved}<span class="form-text text-success small">Saved.</span>{/if}
    </div>
  </div>

  {#if hasPassword}
    <div class="card mb-3">
      <div class="card-body">
        <h2 class="h6 text-body-secondary">Change password</h2>
        <form
          on:submit={(e) => {
            e.preventDefault();
            void changePassword();
          }}
        >
          <div class="row g-2 mb-2">
            <div class="col-12 col-sm-6">
              <input
                class="form-control form-control-sm"
                type="password"
                placeholder="Current password"
                bind:value={currentPassword}
                required
              />
            </div>
            <div class="col-12 col-sm-6">
              <input
                class="form-control form-control-sm"
                type="password"
                placeholder="New password (min 8 chars)"
                minlength="8"
                bind:value={nextPassword}
                required
              />
            </div>
          </div>
          <button type="submit" class="btn btn-sm btn-outline-primary">Change password</button>
        </form>
        {#if passwordSaved}<span class="form-text text-success small">Password changed.</span>{/if}
      </div>
    </div>
  {/if}

  <div class="card">
    <div class="card-body">
      <h2 class="h6 text-body-secondary">API keys</h2>
      <p class="small text-body-secondary mb-3">
        Plain bearer tokens for scripts and CI. This is the only time the full token is shown —
        copy it right away.
      </p>
      {#if newKey}
        <div class="input-group input-group-sm mb-3">
          <input class="form-control font-monospace" value={newKey} readonly />
          <button
            type="button"
            class="btn btn-outline-secondary"
            on:click={() => navigator.clipboard?.writeText(newKey ?? '')}
          >
            Copy
          </button>
          <button type="button" class="btn btn-outline-primary" on:click={() => (newKey = null)}>
            Done
          </button>
        </div>
      {:else}
        <button
          type="button"
          class="btn btn-sm btn-primary mb-3"
          on:click={() => void createKey()}
          disabled={creating}
        >
          Generate API key
        </button>
      {/if}
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr><th class="small text-body-secondary">Prefix</th><th class="small text-body-secondary">Created</th><th></th></tr>
        </thead>
        <tbody>
          {#each keys as key (key.id)}
            <tr>
              <td><code>{key.prefix}…</code></td>
              <td class="small">{new Date(key.createdAt).toLocaleString()}</td>
              <td class="text-end">
                <button
                  type="button"
                  class="btn btn-sm btn-outline-danger"
                  on:click={() => void revokeKey(key.id)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="3" class="small text-body-secondary">No API keys yet.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>
