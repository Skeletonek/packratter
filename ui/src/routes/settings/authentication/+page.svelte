<script lang="ts">
  import { onMount } from 'svelte';
  import { handleApiError } from '$lib/api.js';
  import { showNotice } from '$lib/noticeStore.js';

  interface SsoView {
    exists: boolean;
    enabled: boolean;
    seededFromEnv: boolean;
    issuer: string;
    clientId: string;
    scopes: string;
    adminClaim: string | null;
    adminValue: string | null;
    autoCreate: boolean;
    hasSecret: boolean;
  }

  interface TestResult {
    ok: boolean;
    authorizationEndpoint?: string;
    error?: string;
  }

  let loaded = false;
  let issuer = '';
  let clientId = '';
  let clientSecret = '';
  let scopes = 'openid profile email';
  let adminClaim = '';
  let adminValue = '';
  let autoCreate = true;
  let enabled = true;
  let hasSecret = false;
  let seededFromEnv = false;
  let saving = false;
  let testing = false;
  let testResult: TestResult | null = null;

  onMount(() => void load());

  async function load() {
    const res = await fetch('/api/v1/settings/sso');
    if (!res.ok) {
      handleApiError('LOAD_FAILED', await res.json());
      return;
    }
    const s: SsoView = (await res.json()).data;
    issuer = s.issuer;
    clientId = s.clientId;
    scopes = s.scopes;
    adminClaim = s.adminClaim ?? '';
    adminValue = s.adminValue ?? '';
    autoCreate = s.autoCreate;
    enabled = s.enabled;
    hasSecret = s.hasSecret;
    seededFromEnv = s.seededFromEnv;
    loaded = true;
  }

  async function save() {
    saving = true;
    try {
      const payload: Record<string, unknown> = {
        enabled,
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        scopes: scopes.trim() || undefined,
        adminClaim: adminClaim.trim(),
        adminValue: adminValue.trim(),
        autoCreate,
      };
      const trimmedSecret = clientSecret.trim();
      if (trimmedSecret) payload.clientSecret = trimmedSecret;

      const res = await fetch('/api/v1/settings/sso', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) {
        handleApiError('SSO_SAVE_FAILED', json);
        return;
      }
      clientSecret = '';
      testResult = null;
      showNotice('OIDC configuration saved.');
      await load();
    } finally {
      saving = false;
    }
  }

  async function test() {
    testing = true;
    testResult = null;
    try {
      const res = await fetch('/api/v1/settings/sso/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issuer: issuer.trim() }),
      });
      const json = await res.json();
      if (!json.success) {
        handleApiError('SSO_TEST_FAILED', json);
        return;
      }
      testResult = json.data as TestResult;
    } finally {
      testing = false;
    }
  }
</script>

<div class="card shadow-sm">
  <div class="card-body">
    <div class="d-flex align-items-center gap-2 mb-2">
      <h5 class="card-title mb-0">OpenID Connect</h5>
      {#if seededFromEnv}
        <span class="badge text-bg-secondary" title="Initial values came from the SSO_* environment variables; later edits still apply">seeded from env</span>
      {/if}
    </div>
    <p class="small text-body-secondary">
      Adds a "Sign in with SSO" button to the login page. Local accounts keep working.
      Test the discovery URL before saving — a typo would lock every SSO user out.
    </p>

    {#if !loaded}
      <p class="small text-body-secondary mb-0">Loading…</p>
    {:else}
      <form
        on:submit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-issuer" class="form-label small mb-0">Issuer URL</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <input
              id="sso-issuer"
              class="form-control form-control-sm"
              required
              placeholder="https://sso.example.com/application/o/packratter/"
              bind:value={issuer}
            />
          </div>
        </div>
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-client-id" class="form-label small mb-0">Client ID</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <input id="sso-client-id" class="form-control form-control-sm" required bind:value={clientId} />
          </div>
        </div>
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-client-secret" class="form-label small mb-0">Client secret</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <input
              id="sso-client-secret"
              class="form-control form-control-sm"
              type="password"
              autocomplete="new-password"
              placeholder={hasSecret ? 'leave empty to keep the one on file' : 'PKCE-only if empty'}
              bind:value={clientSecret}
            />
          </div>
        </div>
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-scopes" class="form-label small mb-0">Scopes</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <input id="sso-scopes" class="form-control form-control-sm" bind:value={scopes} />
          </div>
        </div>
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-admin-claim" class="form-label small mb-0">Admin claim</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <div class="input-group input-group-sm">
              <input
                id="sso-admin-claim"
                class="form-control"
                placeholder="realm_access.roles (optional)"
                bind:value={adminClaim}
              />
              <span class="input-group-text">=</span>
              <input
                class="form-control"
                placeholder="packratter-admin (optional)"
                aria-label="Admin claim value"
                bind:value={adminValue}
              />
            </div>
          </div>
        </div>
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-enabled" class="form-label small mb-0">SSO sign-in</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <div class="form-check form-switch mb-0">
              <input id="sso-enabled" class="form-check-input" type="checkbox" bind:checked={enabled} />
              <label for="sso-enabled" class="form-check-label small">enabled</label>
            </div>
          </div>
        </div>
        <div class="row g-2 align-items-center mb-2">
          <div class="col-12 col-md-3 col-lg-2 text-md-end">
            <label for="sso-auto-create" class="form-label small mb-0">Auto-create</label>
          </div>
          <div class="col-12 col-md-9 col-lg-10">
            <div class="form-check form-switch mb-0">
              <input id="sso-auto-create" class="form-check-input" type="checkbox" bind:checked={autoCreate} />
              <label for="sso-auto-create" class="form-check-label small">
                grant accounts on first sign-in
              </label>
            </div>
          </div>
        </div>
        <p class="small text-body-secondary mb-2">
          Identities whose userinfo contains the admin claim value are granted the admin
          role on sign-in; when the claim disappears they lose it again — until an admin
          edits the role manually, after which the claim no longer applies to them.
          Auto-created accounts start with no repository access; grants are made in each
          repository's settings.
        </p>
        <div class="d-flex flex-wrap gap-2">
          <button type="submit" class="btn btn-sm btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary" disabled={testing} on:click={() => void test()}>
            {testing ? 'Testing…' : 'Test discovery'}
          </button>
        </div>
        {#if testResult}
          {#if testResult.ok}
            <div class="alert alert-success py-2 small mt-3 mb-0">
              Discovery OK — <code>{testResult.authorizationEndpoint}</code>
            </div>
          {:else}
            <div class="alert alert-danger py-2 small mt-3 mb-0">
              Discovery failed — {testResult.error}
            </div>
          {/if}
        {/if}
      </form>
    {/if}
  </div>
</div>
