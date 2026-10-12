import { buildServer } from './server.js';
import { applyMigrations } from './db/index.js';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { config } from './config.js';

async function main() {
  applyMigrations();
  await bootstrapAdmin();

  const server = buildServer();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.log.info(`received ${signal}, shutting down`);
      void server.close().then(() => process.exit(0));
    });
  }

  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  server.log.info(`Packratter listening on :${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
