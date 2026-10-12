<script lang="ts">
  import { resolve } from '$app/paths';
  import ErrorDialog from '$lib/ErrorDialog.svelte';
  import { version, buildTime } from '$lib/buildInfo.js';
</script>

<div class="app">
  <header>
    <a href="{resolve('/')}" class="brand">
      <img src="{resolve('/logo.png')}" alt="Packratter logo" width="64" height="64" />
      <span>Packratter</span>
    </a>
  </header>

  <main>
    <slot />
  </main>

  <footer>
    <span>Packratter v{version} · built {new Date(buildTime).toLocaleString()}</span>
    <span>© 2026 Skeletonek</span>
  </footer>
</div>

<ErrorDialog />

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.5;
  }
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #ccc;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: inherit;
    font-weight: 600;
    font-size: 1.25rem;
  }
  main {
    padding: 1rem;
    flex: 1;
  }
  footer {
    padding: 1rem;
    border-top: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    color: #666;
    font-size: 0.875rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
