<script lang="ts">
  import { notice, clearNotice } from './noticeStore.js';

  let timer: ReturnType<typeof setTimeout> | undefined;

  $: if ($notice) {
    clearTimeout(timer);
    timer = setTimeout(clearNotice, 6000);
  }
</script>

{#if $notice}
  <div class="container">
    <div class="alert alert-success alert-dismissible py-2 small fade show" role="status">
      <i class="bi bi-check-circle me-1"></i>{$notice}
      <button type="button" class="btn-close" aria-label="Close" on:click={clearNotice}></button>
    </div>
  </div>
{/if}
