import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { showError } from './errorStore.js';

export interface ApiEnvelope {
  success?: boolean;
  error?: { code?: string; message?: string };
}

export interface UserInfo {
  id: string;
  login: string;
  email: string | null;
  displayName: string | null;
  role: string;
}

// Signed-in browsers send the session cookie automatically; no token headers.
export function handleApiError(prefix: string, json: ApiEnvelope) {
  const code = json.error?.code ?? prefix;
  if (code === 'UNAUTHORIZED') {
    void goto(resolve('/login'));
    return;
  }
  showError(code, json.error?.message ?? 'Unexpected server response');
}
