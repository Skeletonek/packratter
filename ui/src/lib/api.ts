import { get } from 'svelte/store';
import { showError } from './errorStore.js';
import { apiToken } from './tokenStore.js';

export function authHeaders(): Record<string, string> {
  const token = get(apiToken);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function handleApiError(
  prefix: string,
  json: { error?: { code?: string; message?: string } },
) {
  const code = json.error?.code ?? prefix;
  if (code === 'UNAUTHORIZED') {
    showError(code, 'Missing or invalid API token. Set it via the token button in the top bar.');
    return;
  }
  showError(code, json.error?.message ?? 'Unexpected server response');
}
