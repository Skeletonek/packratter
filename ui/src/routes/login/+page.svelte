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

  // second factor state
  let pendingToken: string | null = null;
  let methods: string[] = [];
  let code = '';

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
      } else if (json.error?.code === '2FA_REQUIRED') {
        pendingToken = json.error.pendingToken;
        methods = json.error.methods ?? [];
        if (methods.includes('webauthn') && !methods.includes('totp')) {
          await securityKey();
        }
      } else {
        failed = json.error?.message ?? 'Sign in failed';
      }
    } finally {
      working = false;
    }
  }

  async function submitCode() {
    if (!pendingToken) return;
    failed = '';
    working = true;
    try {
      const res = await fetch('/api/v1/auth/login/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken, code, remember }),
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

  async function securityKey() {
    if (!pendingToken) return;
    failed = '';
    working = true;
    try {
      const startRes = await fetch('/api/v1/auth/login/webauthn/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken }),
      });
      const startJson = await startRes.json();
      if (!startJson.success) {
        failed = startJson.error?.message ?? 'Sign in failed';
        return;
      }
      const { startAuthentication } = await import('@simplewebauthn/browser');
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: startJson.data });
      } catch (err) {
        // Only an explicit cancel is quiet; anything else must be visible.
        if (err instanceof Error && err.name === 'NotAllowedError') return;
        failed = err instanceof Error ? err.message : String(err);
        return;
      }
      const finishRes = await fetch('/api/v1/auth/login/webauthn/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken, credentialId: assertion.id, response: assertion, remember }),
      });
      const finishJson = await finishRes.json();
      if (finishJson.success) {
        setUser(finishJson.data);
        goto(resolve('/'));
      } else {
        failed = finishJson.error?.message ?? 'Sign in failed';
      }
    } finally {
      working = false;
    }
  }

  function cancelSecondFactor() {
    pendingToken = null;
    methods = [];
    code = '';
    failed = '';
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
        {#if pendingToken}
          <p class="small text-body-secondary mb-3">
            Two-factor authentication is required for <strong>{login}</strong>.
          </p>
          {#if methods.includes('totp')}
            <form
              on:submit={(e) => {
                e.preventDefault();
                void submitCode();
              }}
            >
              <div class="mb-3">
                <label for="code" class="form-label small">
                  Authentication code (or a recovery code)
                </label>
                <input
                  id="code"
                  class="form-control font-monospace"
                  bind:value={code}
                  autocomplete="one-time-code"
                  required
                />
              </div>
              <button type="submit" class="btn btn-primary w-100" disabled={working}>
                {working ? 'Verifying…' : 'Verify'}
              </button>
            </form>
          {/if}
          {#if methods.includes('webauthn')}
            <button
              type="button"
              class="btn btn-outline-primary w-100 mt-2"
              on:click={() => void securityKey()}
              disabled={working}
            >
              <i class="bi bi-usb-symbol me-1"></i>Use a security key
            </button>
          {/if}
          <button
            type="button"
            class="btn btn-link w-100 mt-2 small"
            on:click={cancelSecondFactor}
          >
            Back to sign in
          </button>
        {:else}
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
        {/if}
      </div>
    </div>
  </div>
</div>
