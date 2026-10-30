<script lang="ts">
  import '../app.css';
  import { resolve } from '$app/paths';
  import ErrorDialog from '$lib/ErrorDialog.svelte';
  import ThemeToggle from '$lib/ThemeToggle.svelte';
  import TokenInput from '$lib/TokenInput.svelte';
  import { version, buildTime } from '$lib/buildInfo.js';
</script>

<nav class="navbar navbar-expand-lg bg-body-tertiary border-bottom">
  <div class="container">
    <a class="navbar-brand d-flex align-items-center gap-2" href={resolve('/')}>
      <img src={resolve('/logo.png')} alt="Packratter logo" width="40" height="40" />
      <span class="fw-semibold">Packratter</span>
    </a>
    <div class="d-flex align-items-center gap-3">
      <TokenInput />
      <ThemeToggle />
    </div>
  </div>
</nav>

<main class="flex-fill py-4">
  <slot />
</main>

<footer class="border-top py-3 bg-body-tertiary">
  <div class="container d-flex flex-wrap justify-content-between text-body-secondary small">
    <span>Packratter v{version} · built {new Date(buildTime).toLocaleString()}</span>
    <span>© 2026 Skeletonek</span>
  </div>
</footer>

<ErrorDialog />
