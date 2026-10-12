import { writable } from 'svelte/store';

export interface AppError {
  code: string;
  message: string;
}

export const error = writable<AppError | null>(null);

export function showError(code: string, message: string) {
  error.set({ code, message });
}

export function clearError() {
  error.set(null);
}
