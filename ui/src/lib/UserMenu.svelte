<script lang="ts">
  import { resolve } from '$app/paths';
  import { user, setUser } from '$lib/userStore.js';

  let open = false;

  async function signOut() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    setUser(null);
    window.location.assign(resolve('/login'));
  }
</script>

{#if $user}
  <div class="position-relative">
    <button
      type="button"
      class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-2"
      on:click={() => (open = !open)}
      aria-label="Account"
    >
      <i class="bi bi-person-circle"></i>
      <span>{$user.displayName || $user.login}</span>
      {#if $user.role === 'admin'}
        <span class="badge text-bg-secondary">admin</span>
      {/if}
    </button>
    {#if open}
      <div class="dropdown-menu show position-absolute end-0 mt-2" style="z-index: 1000;">
        <a class="dropdown-item" href={resolve('/account')} on:click={() => (open = false)}>
          <i class="bi bi-person me-1"></i>Account
        </a>
        {#if $user.role === 'admin'}
          <a class="dropdown-item" href={resolve('/users')} on:click={() => (open = false)}>
            <i class="bi bi-people me-1"></i>Users
          </a>
        {/if}
        <hr class="dropdown-divider" />
        <button type="button" class="dropdown-item" on:click={signOut}>
          <i class="bi bi-box-arrow-right me-1"></i>Sign out
        </button>
      </div>
    {/if}
  </div>
{:else}
  <a class="btn btn-primary btn-sm" href={resolve('/login')}>Sign in</a>
{/if}
