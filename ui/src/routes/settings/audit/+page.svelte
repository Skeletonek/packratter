<script lang="ts">
  import { onMount } from 'svelte';
  import { handleApiError } from '$lib/api.js';

  interface AuditEntry {
    id: string;
    at: number;
    actorLogin: string;
    action: string;
    subjectType: string | null;
    subjectId: string | null;
    subjectLabel: string | null;
    details: Record<string, unknown> | null;
  }

  let entries: AuditEntry[] = [];
  let total = 0;
  let limit = 50;
  let offset = 0;
  let actionFilter = '';
  let actorFilter = '';
  let search = '';
  let loading = false;

  onMount(() => void load());

  async function load() {
    loading = true;
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (actionFilter) params.set('action', actionFilter);
      if (actorFilter) params.set('actor', actorFilter);
      if (search) params.set('q', search);
      const res = await fetch(`/api/v1/audit?${params}`);
      if (res.ok) {
        const json = await res.json();
        entries = json.data;
        total = json.pagination.total;
      } else {
        handleApiError('LOAD_FAILED', await res.json());
      }
    } finally {
      loading = false;
    }
  }

  function searchNow() {
    offset = 0;
    void load();
  }

  function prevPage() {
    offset = Math.max(0, offset - limit);
    void load();
  }

  function nextPage() {
    offset += limit;
    void load();
  }
</script>

<div class="card">
  <div class="card-body">
    <h2 class="h6 text-body-secondary">Audit trail</h2>
    <p class="small text-body-secondary mb-3">
      Admin and destructive actions with their actor and subject. Retained for
      AUDIT_RETENTION_DAYS (0 keeps them forever).
    </p>

    <form
      class="row g-2 mb-3"
      on:submit={(e) => {
        e.preventDefault();
        searchNow();
      }}
    >
      <div class="col-12 col-sm-4">
        <input
          class="form-control form-control-sm"
          placeholder="Search subject, actor, details"
          bind:value={search}
        />
      </div>
      <div class="col-6 col-sm-3">
        <input
          class="form-control form-control-sm"
          placeholder="Action (e.g. user.)"
          bind:value={actionFilter}
        />
      </div>
      <div class="col-6 col-sm-3">
        <input
          class="form-control form-control-sm"
          placeholder="Actor login"
          bind:value={actorFilter}
        />
      </div>
      <div class="col-12 col-sm-2">
        <button type="submit" class="btn btn-sm btn-outline-primary w-100" disabled={loading}>
          Search
        </button>
      </div>
    </form>

    <table class="table table-sm align-middle">
      <thead>
        <tr>
          <th class="small text-body-secondary">When</th>
          <th class="small text-body-secondary">Actor</th>
          <th class="small text-body-secondary">Action</th>
          <th class="small text-body-secondary">Subject</th>
          <th class="small text-body-secondary">Details</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as entry (entry.id)}
          <tr>
            <td class="small text-nowrap">{new Date(entry.at).toLocaleString()}</td>
            <td class="small">{entry.actorLogin}</td>
            <td><code class="small">{entry.action}</code></td>
            <td class="small">
              {#if entry.subjectLabel}
                {entry.subjectLabel}
              {:else if entry.subjectId}
                {entry.subjectId}
              {:else}
                —
              {/if}
            </td>
            <td class="small text-body-secondary">
              {entry.details ? JSON.stringify(entry.details) : ''}
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="5" class="small text-body-secondary">
              {loading ? 'Loading…' : 'No audit entries match.'}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="d-flex align-items-center justify-content-between">
      <span class="small text-body-secondary">
        {total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <div class="btn-group">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          on:click={prevPage}
          disabled={offset === 0 || loading}
        >
          Previous
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          on:click={nextPage}
          disabled={offset + limit >= total || loading}
        >
          Next
        </button>
      </div>
    </div>
  </div>
</div>
