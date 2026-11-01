import { redirect } from '@sveltejs/kit';
import { base, resolve } from '$app/paths';
import type { LayoutLoad } from './$types';
import { type UserInfo } from '$lib/api.js';
import { setUser } from '$lib/userStore.js';
import { toolchain } from '$lib/toolchainStore.js';

export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = async ({ fetch, url }) => {
  const res = await fetch('/api/v1/me');
  let me: UserInfo | null = null;
  if (res.ok) {
    const json = await res.json();
    me = json.success ? json.data : null;
  }
  setUser(me);

  if (me) {
    const capRes = await fetch('/api/v1/toolchain');
    if (capRes.ok) {
      const caps = await capRes.json();
      toolchain.set(caps.success ? caps.data : null);
    }
  } else {
    toolchain.set(null);
  }

  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  if (!me && path !== '/login') {
    redirect(302, resolve('/login'));
  }
  if (me && path === '/login') {
    redirect(302, resolve('/'));
  }
  return { me };
};
