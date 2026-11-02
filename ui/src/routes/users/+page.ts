import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';

// Users now live as a tab of the settings page; keep old links working.
export function load() {
  redirect(308, resolve('/settings/users'));
}
