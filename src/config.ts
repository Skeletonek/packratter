import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATA_DIR: z.string().default('/data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASS: z.string().min(1),
  GPG_ROOT: z.string().default('/data/keys/gnupg'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
