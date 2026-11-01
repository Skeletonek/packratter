<script lang="ts">
  import { onMount } from 'svelte';
  import { type UserInfo, handleApiError } from '$lib/api.js';
  import { user } from '$lib/userStore.js';

  interface ManagedUser extends UserInfo {
    createdAt: number;
  }

  let users: ManagedUser[] = [];
  let createOpen = false;
  let newLogin = '';
  let newDisplayName = '';
  let newEmail = '';
  let newPassword = '';
  let newRole = 'user';
  let createdPassword: { login: string; password: string } | null = null;
  let creating = false;

  function showOncePassword(login: string, password: string) {
    createdPassword = { login, password };
  }

  onMount(() => void load());

  async function load() {
    const res = await fetch('/api/v1/users');
    if (res.ok) {
      users = (await res.json()).data;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  }

  async function createUser() {
    creating = true;
    createdPassword = null;
    try {
      const res = await fetch('/api/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: newLogin.trim(),
          displayName: newDisplayName.trim() || undefined,
          email: newEmail.trim() || undefined,
          password: newPassword.trim() || undefined,
          role: newRole,
        }),
      });
      const json = await res.json();
      if (json.success) {
        showOncePassword(json.data.login, json.data.password);
        newLogin = '';
        newDisplayName = '';
        newEmail = '';
        newPassword = '';
        createOpen = false;
        await load();
      } else {
        handleApiError('USER_REJECTED', json);
      }
    } finally {
      creating = false;
    }
  }

  async function updateUser(target: ManagedUser, patch: Record<string, unknown>) {
    const res = await fetch(`/api/v1/users/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      handleApiError('USER_REJECTED', await res.json());
      await load();
    }
  }

  async function removeUser(target: ManagedUser) {
    if (!confirm(`Delete user "${target.login}"? Their API keys and sessions are removed with them.`)) return;
    const res = await fetch(`/api/v1/users/${target.id}`, { method: 'DELETE' });
    if (!res.ok) {
      handleApiError('USER_REJECTED', await res.json());
    }
    await load();
  }

  async function resetPassword(target: ManagedUser) {
    if (!confirm(`Reset the password of "${target.login}"? An old one won't work anymore.`)) return;
    const res = await fetch(`/api/v1/users/${target.id}/password`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showOncePassword(json.data.login, json.data.password);
    } else {
      handleApiError('PASSWORD_RESET_FAILED', json);
    }
  }
</script>

<div class="container">
  <h1 class="h4 mb-3">Users</h1>

  {#if createdPassword}
    <div class="alert alert-warning py-2 small">
      Password for <strong>{createdPassword.login}</strong>:
      <code>{createdPassword.password}</code> — shown only once, pass it along securely.
      <button
        type="button"
        class="btn-close float-end"
        aria-label="Close"
        on:click={() => (createdPassword = null)}
      ></button>
    </div>
  {/if}

  <div class="card">
    <div class="table-responsive">
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th class="small text-body-secondary">Login</th>
            <th class="small text-body-secondary">Display name</th>
            <th class="small text-body-secondary">Email</th>
            <th class="small text-body-secondary">Role</th>
            <th class="small text-body-secondary">Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each users as u (u.id)}
            <tr>
              <td>
                <input
                  class="form-control form-control-sm"
                  style="max-width: 10rem;"
                  bind:value={u.login}
                  on:change={() => void updateUser(u, { login: u.login })}
                />
              </td>
              <td style="max-width: 10rem;">
                <input
                  class="form-control form-control-sm"
                  bind:value={u.displayName}
                  placeholder="(login shown)"
                  on:change={() => void updateUser(u, { displayName: u.displayName ?? '' })}
                />
              </td>
              <td style="max-width: 14rem;">
                <input
                  class="form-control form-control-sm"
                  type="text"
                  bind:value={u.email}
                  on:change={() => void updateUser(u, { email: u.email ?? '' })}
                />
              </td>
              <td>
                <select
                  class="form-select form-select-sm"
                  value={u.role}
                  on:change={(e) => void updateUser(u, { role: (e.currentTarget as HTMLSelectElement).value })}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td class="small">{new Date(u.createdAt).toLocaleDateString()}</td>
              <td class="text-end">
                {#if u.id === $user?.id}
                  <span class="form-text small">you</span>
                {:else}
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary me-1"
                    title="Generate a new password, shown once"
                    on:click={() => void resetPassword(u)}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger"
                    on:click={() => void removeUser(u)}
                  >
                    Delete
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>

  <div class="card mt-3">
    <div class="card-body">
      <button
        type="button"
        class="btn btn-sm btn-outline-primary"
        on:click={() => (createOpen = !createOpen)}
      >
        <i class="bi bi-person-plus me-1"></i>Create user
      </button>

      {#if createOpen}
        <form
          class="row g-2 align-items-end mt-2"
          on:submit|preventDefault={createUser}
        >
          <div class="col-12 col-sm-3">
            <label for="new-login" class="form-label small mb-0">Login</label>
            <input id="new-login" class="form-control form-control-sm" bind:value={newLogin} required />
          </div>
          <div class="col-12 col-sm-3">
            <label for="new-display" class="form-label small mb-0">Display name (optional)</label>
            <input id="new-display" class="form-control form-control-sm" type="text" bind:value={newDisplayName} />
          </div>
          <div class="col-12 col-sm-3">
            <label for="new-email" class="form-label small mb-0">Email (optional)</label>
            <input id="new-email" class="form-control form-control-sm" type="text" bind:value={newEmail} />
          </div>
          <div class="col-6 col-sm-1">
            <label for="new-role" class="form-label small mb-0">Role</label>
            <select id="new-role" class="form-select form-select-sm" bind:value={newRole}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div class="col-6 col-sm-2 d-grid">
            <button type="submit" class="btn btn-sm btn-primary" disabled={creating}>
              {creating ? '…' : 'Create'}
            </button>
          </div>
          <div class="col-12">
            <span class="form-text small">Empty password → generated and shown once (min 8 chars).</span>
            <input
              class="form-control form-control-sm mt-1"
              type="text"
              placeholder="Initial password (optional)"
              bind:value={newPassword}
              minlength="8"
              autocomplete="off"
            />
          </div>
        </form>
      {/if}
    </div>
  </div>
</div>
