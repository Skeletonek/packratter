import type { RepoType } from '../formats/index.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { run } from './exec.js';

export const REQUIRED_TOOLS: Record<RepoType, string[]> = {
  pacman: ['bsdtar', 'repo-add', 'gpg'],
  deb: ['dpkg-deb', 'apt-ftparchive', 'gpg'],
  rpm: ['rpm', 'createrepo_c', 'gpg'],
  flatpak: ['ostree', 'flatpak', 'gpg'],
};

export interface TypeCapability {
  /** usable for create/upload (not disabled, tools present) */
  ok: boolean;
  missing: string[];
  /** turned off via DISABLE_<TYPE>=1 — policy, not breakage */
  disabledByConfig: boolean;
}

export type ToolchainState = Record<RepoType, TypeCapability>;

async function commandAvailable(name: string): Promise<boolean> {
  try {
    // `command` is a shell builtin, hence the wrapping /bin/sh.
    const res = await run('/bin/sh', ['-c', `command -v -- ${name}`], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    return res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Live scan rather than a cached boot snapshot: one `command -v` per distinct
// tool, cheap enough to re-run for every create/upload so freshly installed
// tooling counts without a restart.
export async function scanToolchain(): Promise<ToolchainState> {
  const names = [...new Set(Object.values(REQUIRED_TOOLS).flat())];
  const checks = await Promise.all(
    names.map(async (name) => [name, await commandAvailable(name)] as const),
  );
  const found = new Set(checks.filter(([, ok]) => ok).map(([name]) => name));

  const state = {} as ToolchainState;
  const disabledFlags: Record<RepoType, boolean> = {
    pacman: config.DISABLE_PACMAN,
    deb: config.DISABLE_DEB,
    rpm: config.DISABLE_RPM,
    flatpak: config.DISABLE_FLATPAK,
  };
  for (const [type, tools] of Object.entries(REQUIRED_TOOLS) as [RepoType, string[]][]) {
    const disabledByConfig = disabledFlags[type];
    const missing = tools.filter((tool) => !found.has(tool));
    state[type] = {
      ok: !disabledByConfig && missing.length === 0,
      missing,
      disabledByConfig,
    };
  }
  return state;
}

export function unavailableMessage(type: RepoType, cap: TypeCapability): string {
  if (cap.disabledByConfig) {
    return `${type} is disabled by configuration (DISABLE_${type.toUpperCase()}=1)`;
  }
  return `${type} tooling is missing on the server (${cap.missing.join(', ')}); install it to enable this package type`;
}

// Guard for creation and upload paths; pass the state from scanToolchain().
export function assertTypeAvailable(type: RepoType, state: ToolchainState): void {
  const cap = state[type];
  if (!cap.ok) {
    const code = cap.disabledByConfig ? 'TYPE_DISABLED' : 'TOOLCHAIN_MISSING';
    throw new AppError(code, unavailableMessage(type, cap), 409);
  }
}
