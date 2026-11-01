import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATA_DIR: z.string().default('/data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Public base URL used in setup snippets; empty string treated as unset */
  BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASS: z.string().min(1),
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
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
