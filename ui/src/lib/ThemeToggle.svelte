<script lang="ts">
  import { theme, toggleTheme } from './themeStore.js';
</script>

<button type="button" class="btn btn-outline-secondary btn-sm" on:click={toggleTheme} aria-label="Toggle theme">
  {#if $theme === 'dark'}
    <i class="bi bi-sun-fill"></i>
  {:else}
    <i class="bi bi-moon-fill"></i>
  {/if}
</button>
