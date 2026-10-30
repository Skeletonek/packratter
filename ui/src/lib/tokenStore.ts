import { writable } from 'svelte/store';
import { browser } from '$app/environment';

function readInitial(): string {
  if (!browser) return '';
  return localStorage.getItem('apiToken') ?? '';
}

function persist(token: string) {
  if (browser) {
    if (token) localStorage.setItem('apiToken', token);
    else localStorage.removeItem('apiToken');
  }
}

export const apiToken = writable<string>(readInitial());
apiToken.subscribe(persist);
