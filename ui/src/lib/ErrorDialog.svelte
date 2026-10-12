<script lang="ts">
  import { onDestroy } from 'svelte';
  import { error, clearError } from './errorStore.js';

  let dialog: HTMLDialogElement;
  let current: { code: string; message: string } | null = null;

  const unsubscribe = error.subscribe((value) => {
    current = value;
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

<dialog bind:this={dialog} on:close={clearError}>
  {#if current}
    <h2>Error: {current.code}</h2>
    <pre>{current.message}</pre>
    <button on:click={close}>Close</button>
  {/if}
</dialog>

<style>
  dialog {
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    padding: 1.5rem;
    max-width: 90vw;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: #f5f5f5;
    padding: 0.75rem;
    border-radius: 0.25rem;
  }
  button {
    margin-top: 1rem;
  }
</style>
