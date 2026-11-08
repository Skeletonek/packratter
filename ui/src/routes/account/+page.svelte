<script lang="ts">
  import { onMount } from 'svelte';
  import { type UserInfo, handleApiError } from '$lib/api.js';
  import { askInput } from '$lib/promptStore.js';
  import { setUser } from '$lib/userStore.js';

  interface ApiKey {
    id: string;
    prefix: string;
    createdAt: number;
    expiresAt: number | null;
    lastUsedAt: number | null;
  }

  interface Session {
    id: string;
    createdAt: number;
    expiresAt: number;
    userAgent: string | null;
    current: boolean;
  }

  interface WebAuthnKey {
    id: string;
    label: string | null;
    createdAt: number;
    lastUsedAt: number | null;
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
  let keyExpiryDays: number | null = null;
  let sessions: Session[] = [];
  let totpEnabled = false;
  let totpPending = false;
  let webauthnKeys: WebAuthnKey[] = [];
  let totpSecret: string | null = null;
  let totpUri: string | null = null;
  let totpQrDataUrl: string | null = null;
  let totpCodeInput = '';
  let recoveryCodes: string[] | null = null;

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
    await Promise.all([loadKeys(), loadSessions(), load2fa()]);
  });

  async function loadKeys() {
    const res = await fetch('/api/v1/keys');
    if (res.ok) {
      keys = (await res.json()).data;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  }

  async function loadSessions() {
    const res = await fetch('/api/v1/sessions');
    if (res.ok) {
      sessions = (await res.json()).data;
    } else {
      handleApiError('LOAD_FAILED', await res.json());
    }
  }

  async function load2fa() {
    const res = await fetch('/api/v1/me/2fa');
    if (res.ok) {
      const data = (await res.json()).data;
      totpEnabled = data.totpEnabled;
      totpPending = data.totpPending;
      webauthnKeys = data.webauthnKeys;
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
      const res = await fetch('/api/v1/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keyExpiryDays ? { expiresInDays: keyExpiryDays } : {}),
      });
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

  async function revokeSession(id: string) {
    const res = await fetch(`/api/v1/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      handleApiError('SESSION_REVOKE_FAILED', await res.json());
    }
    await loadSessions();
  }

  async function revokeAllSessions() {
    const res = await fetch('/api/v1/sessions/revoke-all', { method: 'POST' });
    if (!res.ok) {
      handleApiError('SESSION_REVOKE_FAILED', await res.json());
    }
    // every session is gone, this one included
    window.location.href = '/login';
  }

  async function setupTotp() {
    totpSecret = null;
    totpUri = null;
    totpQrDataUrl = null;
    // Factor changes need password proof, not just the session.
    const password = await askInput({
      title: 'Set up TOTP',
      message: 'Enter your password to continue.',
    });
    if (password === null) return;
    const res = await fetch('/api/v1/me/2fa/totp/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const json = await res.json();
    if (json.success) {
      totpSecret = json.data.secret;
      totpUri = json.data.otpauthUri;
      // rendered locally — the secret never leaves the browser
      const QRCode = await import('qrcode');
      totpQrDataUrl = await QRCode.toDataURL(json.data.otpauthUri, { margin: 1 });
    } else {
      handleApiError('TOTP_SETUP_FAILED', json);
    }
  }

  async function confirmTotp() {
    const res = await fetch('/api/v1/me/2fa/totp/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: totpCodeInput }),
    });
    const json = await res.json();
    if (json.success) {
      // TOTP stays off until the codes are confirmed saved (see activateTotp).
      recoveryCodes = json.data.recoveryCodes;
      totpSecret = null;
      totpUri = null;
      totpCodeInput = '';
    } else {
      handleApiError('TOTP_CONFIRM_FAILED', json);
    }
  }

  async function activateTotp() {
    const res = await fetch('/api/v1/me/2fa/totp/activate', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      recoveryCodes = null;
      await load2fa();
    } else {
      handleApiError('TOTP_ACTIVATE_FAILED', json);
    }
  }

  function downloadCodes() {
    if (!recoveryCodes) return;
    const blob = new Blob([recoveryCodes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'packratter-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function disableTotp() {
    const code = await askInput({
      title: 'Disable TOTP',
      message: 'Enter an authentication code, a recovery code, or your password.',
    });
    if (code === null) return;
    const res = await fetch('/api/v1/me/2fa/totp/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, password: code }),
    });
    if (!res.ok) {
      handleApiError('TOTP_DISABLE_FAILED', await res.json());
      return;
    }
    recoveryCodes = null;
    await load2fa();
  }

  async function registerKey() {
    const { startRegistration } = await import('@simplewebauthn/browser');
    const startRes = await fetch('/api/v1/me/2fa/webauthn/register/start', { method: 'POST' });
    const startJson = await startRes.json();
    if (!startJson.success) {
      handleApiError('KEY_REGISTER_FAILED', startJson);
      return;
    }
    let attestation;
    try {
      attestation = await startRegistration({ optionsJSON: startJson.data });
    } catch (err) {
      // WebAuthn failures (insecure context, origin mismatch, missing key)
      // must not vanish silently — only an explicit cancel is quiet.
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      handleApiError('KEY_REGISTER_FAILED', {
        success: false,
        error: {
          code: 'KEY_REGISTER_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }
    const password = await askInput({
      title: 'Add security key',
      message: 'Enter your password to continue.',
    });
    if (password === null) return;
    const label = await askInput({
      title: 'Name this security key',
      message: 'Shown in your key list, e.g. "YubiKey 5".',
      masked: false,
    });
    const finishRes = await fetch('/api/v1/me/2fa/webauthn/register/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label ?? undefined, password, response: attestation }),
    });
    const finishJson = await finishRes.json();
    if (!finishJson.success) {
      handleApiError('KEY_REGISTER_FAILED', finishJson);
      return;
    }
    await load2fa();
  }

  async function removeKey(id: string) {
    const password = await askInput({
      title: 'Remove security key',
      message: 'Enter your password to continue.',
    });
    if (password === null) return;
    const res = await fetch(`/api/v1/me/2fa/webauthn/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      handleApiError('KEY_REMOVE_FAILED', await res.json());
      return;
    }
    await load2fa();
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

  <div class="card mb-3">
    <div class="card-body">
      <h2 class="h6 text-body-secondary">Two-factor authentication</h2>
      <p class="small text-body-secondary mb-3">
        Second factor for local sign-in. SSO accounts use their provider's own second factor
        instead.
      </p>

      {#if recoveryCodes}
        <div class="alert alert-warning">
          <p class="small mb-2">
            <strong>Recovery codes — shown once.</strong> Store them somewhere safe; each works
            once when you lose your authenticator. TOTP turns on only after you confirm.
          </p>
          <ul class="small font-monospace mb-2">
            {#each recoveryCodes as code (code)}<li>{code}</li>{/each}
          </ul>
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-sm btn-outline-secondary" on:click={downloadCodes}>
              <i class="bi bi-download me-1"></i>Download .txt
            </button>
            <button type="button" class="btn btn-sm btn-primary" on:click={() => void activateTotp()}>
              I saved my recovery codes
            </button>
          </div>
        </div>
      {/if}

      <div class="mb-3">
        <div class="d-flex align-items-center gap-2 mb-2">
          <i class="bi bi-phone"></i>
          <strong class="small">Authenticator app (TOTP)</strong>
          {#if totpEnabled}
            <span class="badge text-bg-success">Enabled</span>
          {/if}
        </div>
        {#if totpSecret}
          <p class="small mb-1">
            Scan the QR code in your authenticator app, or enter the key manually, then confirm
            with a code.
          </p>
          {#if totpQrDataUrl}
            <img
              src={totpQrDataUrl}
              alt="TOTP QR code"
              class="mb-2"
              width="140"
              height="140"
            />
          {/if}
          <p class="small font-monospace mb-2">{totpSecret}</p>
          <div class="input-group input-group-sm" style="max-width: 260px">
            <input
              class="form-control"
              placeholder="123456"
              bind:value={totpCodeInput}
              maxlength="6"
            />
            <button type="button" class="btn btn-primary" on:click={() => void confirmTotp()}>
              Confirm
            </button>
          </div>
        {:else if totpEnabled}
          <button type="button" class="btn btn-sm btn-outline-danger" on:click={() => void disableTotp()}>
            Disable TOTP
          </button>
        {:else if totpPending}
          <p class="small text-body-secondary mb-2">
            Setup is waiting for your recovery codes confirmation. If you no longer have the
            codes, start setup again to get a fresh set.
          </p>
          <button type="button" class="btn btn-sm btn-outline-primary" on:click={() => void setupTotp()}>
            Restart setup
          </button>
        {:else}
          <button type="button" class="btn btn-sm btn-outline-primary" on:click={() => void setupTotp()}>
            Set up TOTP
          </button>
        {/if}
      </div>

      <div>
        <div class="d-flex align-items-center gap-2 mb-2">
          <i class="bi bi-usb-symbol"></i>
          <strong class="small">Security keys (WebAuthn)</strong>
        </div>
        <table class="table table-sm align-middle mb-2">
          <thead>
            <tr>
              <th class="small text-body-secondary">Label</th>
              <th class="small text-body-secondary">Added</th>
              <th class="small text-body-secondary">Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each webauthnKeys as key (key.id)}
              <tr>
                <td>{key.label ?? 'Security key'}</td>
                <td class="small">{new Date(key.createdAt).toLocaleString()}</td>
                <td class="small"
                  >{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : '—'}</td
                >
                <td class="text-end">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger"
                    on:click={() => void removeKey(key.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            {:else}
              <tr><td colspan="4" class="small text-body-secondary">No security keys.</td></tr>
            {/each}
          </tbody>
        </table>
        <button type="button" class="btn btn-sm btn-outline-primary" on:click={() => void registerKey()}>
          Add security key
        </button>
      </div>
    </div>
  </div>

  <div class="card mb-3">
    <div class="card-body">
      <h2 class="h6 text-body-secondary">Sessions</h2>
      <p class="small text-body-secondary mb-3">Devices currently signed in to your account.</p>
      <table class="table table-sm align-middle mb-2">
        <thead>
          <tr>
            <th class="small text-body-secondary">Device</th>
            <th class="small text-body-secondary">Signed in</th>
            <th class="small text-body-secondary">Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each sessions as session (session.id)}
            <tr>
              <td class="small">
                {session.userAgent ?? 'Unknown device'}
                {#if session.current}<span class="badge text-bg-secondary">this device</span>{/if}
              </td>
              <td class="small">{new Date(session.createdAt).toLocaleString()}</td>
              <td class="small">{new Date(session.expiresAt).toLocaleString()}</td>
              <td class="text-end">
                {#if !session.current}
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger"
                    on:click={() => void revokeSession(session.id)}
                  >
                    Sign out
                  </button>
                {/if}
              </td>
            </tr>
          {:else}
            <tr><td colspan="4" class="small text-body-secondary">No sessions.</td></tr>
          {/each}
        </tbody>
      </table>
      <button type="button" class="btn btn-sm btn-outline-danger" on:click={() => void revokeAllSessions()}>
        Sign out everywhere
      </button>
    </div>
  </div>

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
        <div class="d-flex align-items-center gap-2 mb-3">
          <button
            type="button"
            class="btn btn-sm btn-primary"
            on:click={() => void createKey()}
            disabled={creating}
          >
            Generate API key
          </button>
          <label class="small text-body-secondary mb-0" for="key-expiry">expires in</label>
          <select id="key-expiry" class="form-select form-select-sm" style="width: auto" bind:value={keyExpiryDays}>
            <option value={null}>never</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>1 year</option>
          </select>
        </div>
      {/if}
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th class="small text-body-secondary">Prefix</th>
            <th class="small text-body-secondary">Created</th>
            <th class="small text-body-secondary">Expires</th>
            <th class="small text-body-secondary">Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each keys as key (key.id)}
            <tr>
              <td><code>{key.prefix}…</code></td>
              <td class="small">{new Date(key.createdAt).toLocaleString()}</td>
              <td class="small">{key.expiresAt ? new Date(key.expiresAt).toLocaleString() : 'never'}</td>
              <td class="small">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}</td>
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
            <tr><td colspan="5" class="small text-body-secondary">No API keys yet.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>
