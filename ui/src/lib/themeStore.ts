import { writable } from 'svelte/store';
import { browser } from '$app/environment';

type Theme = 'light' | 'dark';

function readInitial(): Theme {
  if (!browser) return 'light';
  const stored = localStorage.getItem('theme') as Theme | null;
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme) {
  if (browser) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    localStorage.setItem('theme', theme);
  }
}

export const theme = writable<Theme>(readInitial());
theme.subscribe(apply);

export function toggleTheme() {
  theme.update((current) => (current === 'light' ? 'dark' : 'light'));
}
