import { writable } from 'svelte/store';

export interface PromptRequest {
  title: string;
  message: string | null;
  masked: boolean;
  resolve: (value: string | null) => void;
}

export const promptRequest = writable<PromptRequest | null>(null);

/** Promise-based prompt; resolves null when cancelled. */
export function askInput(opts: {
  title: string;
  message?: string;
  masked?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    promptRequest.set({
      title: opts.title,
      message: opts.message ?? null,
      masked: opts.masked ?? true,
      resolve,
    });
  });
}

export function resolvePrompt(value: string | null): void {
  promptRequest.update((req) => {
    req?.resolve(value);
    return null;
  });
}
