<script lang="ts">
  import { onDestroy } from 'svelte';
  import { promptRequest, resolvePrompt } from './promptStore.js';

  let dialog: HTMLDialogElement;
  let current: { title: string; message: string | null; masked: boolean } | null = null;
  let value = '';

  const unsubscribe = promptRequest.subscribe((req) => {
    current = req;
    value = '';
    if (req && dialog) {
      dialog.showModal();
    }
  });

  onDestroy(unsubscribe);

  function submit() {
    if (!value) return;
    const answer = value;
    resolvePrompt(answer);
    dialog.close();
  }

  function cancel() {
    resolvePrompt(null);
    dialog.close();
  }
</script>

<!-- on:cancel, not on:close: close() fires the close event as a queued task, so
     with on:close a dialog opened right after the previous one (the label prompt
     following the password prompt) would be cancelled by the lingering event. -->
<dialog bind:this={dialog} class="rounded-3 shadow" on:cancel={cancel}>
  {#if current}
    <form
      class="modal-content"
      on:submit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="modal-header">
        <h5 class="modal-title">{current.title}</h5>
        <button type="button" class="btn-close" on:click={cancel} aria-label="Close"></button>
      </div>
      <div class="modal-body">
        {#if current.message}
          <p class="small text-body-secondary">{current.message}</p>
        {/if}
        <!-- masked by default: this dialog collects passwords -->
        <input
          class="form-control"
          type={current.masked ? 'password' : 'text'}
          bind:value
          required
          autocomplete={current.masked ? 'current-password' : 'off'}
        />
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" on:click={cancel}>Cancel</button>
        <button type="submit" class="btn btn-primary">OK</button>
      </div>
    </form>
  {/if}
</dialog>
