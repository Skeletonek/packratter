import { writable } from 'svelte/store';

/** Transient success/confirmation banner (single message at a time). */
export const notice = writable<string | null>(null);

export function showNotice(message: string) {
  notice.set(message);
}

export function clearNotice() {
  notice.set(null);
}
