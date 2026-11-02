<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { setUser } from '$lib/userStore.js';

  let login = '';
  let password = '';
  let remember = false;
  let working = false;
  let failed = '';
  let ssoEnabled = false;

  const ssoResult = page.url.searchParams.get('sso');
  const ssoNotice =
    ssoResult === 'denied'
      ? 'No account exists for this identity — ask an admin to create one.'
      : ssoResult === 'failed'
        ? 'SSO sign-in failed.'
        : '';

  onMount(async () => {
    const res = await fetch('/api/v1/auth/sso/status');
    const json = await res.json();
    ssoEnabled = json.success === true && json.data?.enabled === true;
  });

  async function submit() {
    failed = '';
    working = true;
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password, remember }),
      });
      const json = await res.json();
      if (json.success) {
        setUser(json.data);
        goto(resolve('/'));
      } else {
        failed = json.error?.message ?? 'Sign in failed';
      }
    } finally {
      working = false;
    }
  }
</script>

<div class="row justify-content-center">
  <div class="col-12 col-sm-8 col-md-6 col-lg-4">
    <div class="card">
      <div class="card-body">
        <h1 class="h4 mb-3">Sign in to Packratter</h1>
        {#if failed}
          <div class="alert alert-danger py-2 small" role="alert">{failed}</div>
        {/if}
        {#if ssoNotice}
          <div class="alert alert-warning py-2 small" role="alert">{ssoNotice}</div>
        {/if}
        {#if ssoEnabled}
          <a class="btn btn-outline-primary w-100 mb-3" href="/api/v1/auth/sso/start">
            <i class="bi bi-box-arrow-in-right me-1"></i>Sign in with SSO
          </a>
          <p class="text-center small text-body-secondary mb-3">or with a local account</p>
        {/if}
        <form
          on:submit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div class="mb-3">
            <label for="login" class="form-label small">Login</label>
            <input id="login" class="form-control" bind:value={login} required />
          </div>
          <div class="mb-3">
            <label for="password" class="form-label small">Password</label>
            <input id="password" type="password" class="form-control" bind:value={password} required />
          </div>
          <div class="form-check mb-3">
            <input id="remember" type="checkbox" class="form-check-input" bind:checked={remember} />
            <label for="remember" class="form-check-label small">Remember this device</label>
          </div>
          <button type="submit" class="btn btn-primary w-100" disabled={working}>
            {working ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  </div>
</div>
