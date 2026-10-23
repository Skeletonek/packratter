<script lang="ts">
  import { onDestroy } from 'svelte';
  import { error, clearError } from './errorStore.js';

  let dialog: HTMLDialogElement;
  let showDetails = false;
  let current: { code: string; message: string } | null = null;

  const unsubscribe = error.subscribe((value) => {
    current = value;
    showDetails = false;
    if (value && dialog) {
      dialog.showModal();
    }
  });

  onDestroy(unsubscribe);

  function close() {
    clearError();
    dialog.close();
  }
</script>

<dialog bind:this={dialog} class="rounded-3 shadow" on:close={clearError}>
  {#if current}
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">
          <i class="bi bi-exclamation-triangle-fill text-danger me-2"></i>
          {current.code}
        </h5>
        <button type="button" class="btn-close" on:click={close} aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <p>Something went wrong. You can view the full error details below.</p>
        <details bind:open={showDetails}>
          <summary class="user-select-none">Show full error</summary>
          <pre class="mt-2 p-2 rounded bg-body-tertiary border"><code>{current.message}</code></pre>
        </details>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" on:click={close}>Close</button>
      </div>
    </div>
  {/if}
</dialog>
