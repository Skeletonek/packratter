<script lang="ts">
  import { toolchain } from './toolchainStore.js';

  const LABELS: Record<string, string> = {
    pacman: 'Pacman',
    deb: 'Deb',
    rpm: 'RPM',
    flatpak: 'Flatpak',
  };
</script>

{#if $toolchain}
  {#each Object.entries($toolchain) as [type, cap] (type)}
    {#if !cap.ok && !cap.disabledByConfig}
      <div class="container">
        <div class="alert alert-warning py-2 small" role="alert">
          <i class="bi bi-exclamation-triangle me-1"></i>
          <strong>{LABELS[type] ?? type}</strong> repositories are disabled — the server is missing
          tooling: {cap.missing.join(', ')}. Install it (see the toolchain docs) and the type will
          work again without restarting.
        </div>
      </div>
    {/if}
  {/each}
{/if}
