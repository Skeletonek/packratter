<script lang="ts">
  import { apiToken } from './tokenStore.js';

  let open = false;
  let draft = '';

  function toggle() {
    open = !open;
    if (open) draft = $apiToken;
  }

  function save() {
    apiToken.set(draft.trim());
    open = false;
  }
</script>

<div class="position-relative">
  <button type="button" class="btn btn-outline-secondary btn-sm" on:click={toggle} aria-label="API token">
    <i class="bi bi-key"></i>
  </button>
  {#if open}
    <div
      class="position-absolute end-0 mt-2 p-3 border rounded bg-body shadow-sm"
      style="width: 18rem; z-index: 1000;"
    >
      <label for="api-token" class="form-label small">API token (needed for write actions)</label>
      <input
        id="api-token"
        type="password"
        class="form-control form-control-sm"
        placeholder="pkt_..."
        bind:value={draft}
      />
      <button type="button" class="btn btn-sm btn-primary w-100 mt-2" on:click={save}>Save</button>
    </div>
  {/if}
</div>
