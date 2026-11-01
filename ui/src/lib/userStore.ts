import { writable } from 'svelte/store';
import type { UserInfo } from './api.js';

/** Current signed-in user (null = signed out). Filled by the layout guard. */
export const user = writable<UserInfo | null>(null);

export function setUser(value: UserInfo | null) {
  user.set(value);
}
