import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATA_DIR: z.string().default('/data'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Public base URL used in setup snippets; empty string treated as unset */
    BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    ADMIN_USER: z.string().min(1),
    /** Optional: when unset, a password is generated and printed once at first boot */
    ADMIN_PASS: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
    GPG_ROOT: z.string().default('/data/keys/gnupg'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    /** Maximum accepted upload size in MiB */
    MAX_UPLOAD_MB: z.coerce.number().int().positive().default(2048),
    /** Per-repo disk quota in MiB, counting each distinct package blob once; 0 = unlimited */
    REPO_QUOTA_MB: z.coerce.number().int().min(0).default(0),
    /** Timeout for external commands (gpg, repo-add, apt-ftparchive, ...) in seconds */
    COMMAND_TIMEOUT_S: z.coerce.number().int().positive().default(300),
    /** Write requests allowed per window per client; 0 disables rate limiting */
    RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(60),
    RATE_LIMIT_WINDOW_S: z.coerce.number().int().positive().default(60),
    /** Base lifetime of a login session in minutes */
    SESSION_TTL_MIN: z.coerce.number().int().positive().default(1440),
    /** Session length for "remember this device" logins, in days */
    SESSION_REMEMBER_DAYS: z.coerce.number().int().positive().default(7),
    /** Turn an ecosystem off entirely, regardless of installed tools ('1' enables) */
    DISABLE_PACMAN: disabledFlag('DISABLE_PACMAN'),
    DISABLE_DEB: disabledFlag('DISABLE_DEB'),
    DISABLE_RPM: disabledFlag('DISABLE_RPM'),
    DISABLE_FLATPAK: disabledFlag('DISABLE_FLATPAK'),
    /** Set '1' when behind a TLS-terminating reverse proxy so rate limiting
     *  (and request IPs) use the real client address instead of the proxy's. */
    TRUST_PROXY: disabledFlag('TRUST_PROXY'),
    /** OIDC sign-in; all three must be set to enable it */
    SSO_ISSUER: z.preprocess(emptyToUndefined, z.string().url().optional()),
    SSO_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    SSO_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Space-separated scopes to request; extend to fetch group/roles claims */
    SSO_SCOPES: z.preprocess(emptyToUndefined, z.string().optional()),
    /** userinfo claim (dotted path ok) whose value grants admin; needs SSO_ADMIN_VALUE */
    SSO_ADMIN_CLAIM: z.preprocess(emptyToUndefined, z.string().optional()),
    SSO_ADMIN_VALUE: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Set '0' to deny SSO sign-in for identities without an existing account */
    SSO_AUTO_CREATE: enabledFlag('SSO_AUTO_CREATE'),
  })
  .refine(
    (cfg) =>
      (cfg.SSO_ISSUER !== undefined) === (cfg.SSO_CLIENT_ID !== undefined) &&
      (cfg.SSO_ISSUER !== undefined) === (cfg.SSO_CLIENT_SECRET !== undefined),
    { message: 'SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET must be set together' },
  )
  .refine((cfg) => (cfg.SSO_ADMIN_CLAIM !== undefined) === (cfg.SSO_ADMIN_VALUE !== undefined), {
    message: 'SSO_ADMIN_CLAIM and SSO_ADMIN_VALUE must be set together',
  });

/** Strict on/off: only '1'/'true' count, so a stray "false" never enables. */
function disabledFlag(_name: string) {
  return z.preprocess((value) => value === '1' || value === 'true', z.boolean().default(false));
}

/** Opt-out: only '0'/'false' disable; unset keeps the feature on. */
function enabledFlag(_name: string) {
  return z.preprocess((value) => value !== '0' && value !== 'false', z.boolean().default(true));
}

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
