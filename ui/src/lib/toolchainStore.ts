import { writable } from 'svelte/store';

export interface TypeCapability {
  ok: boolean;
  missing: string[];
  /** turned off via DISABLE_<TYPE>=1 — banner stays quiet about it */
  disabledByConfig: boolean;
}

/** Per-ecosystem tool availability on the server; null = not loaded yet. */
export const toolchain = writable<Record<string, TypeCapability> | null>(null);
