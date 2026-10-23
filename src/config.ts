import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATA_DIR: z.string().default('/data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Public base URL used in setup snippets; empty string treated as unset */
  BASE_URL: z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional()),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASS: z.string().min(1),
  GPG_ROOT: z.string().default('/data/keys/gnupg'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // TODO: remove ENABLE_FLATPAK once flatpak support is verified stable in production.
  ENABLE_FLATPAK: z.preprocess((value) => value === 'true' || value === '1' || value === true, z.boolean()).default(false),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
