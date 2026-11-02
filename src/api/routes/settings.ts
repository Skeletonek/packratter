import { FastifyPluginAsync } from 'fastify';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { config } from '../../config.js';
import { requireAdmin } from './auth.js';
import { gpgHome } from '../../gpg/index.js';
import { clearDiscoveryCache, loadSsoConfig, ssoEnabled, testDiscovery } from '../../auth/sso.js';

// Settings are boot-time configuration: the read-only view carries the value
// for ordinary entries and only a configured flag for secrets, which are
// never sent to the client.
const envEntries: { key: string; value: () => string; secret?: boolean }[] = [
  { key: 'NODE_ENV', value: () => config.NODE_ENV },
  { key: 'PORT', value: () => String(config.PORT) },
  { key: 'BASE_URL', value: () => config.BASE_URL ?? '' },
  { key: 'DATA_DIR', value: () => config.DATA_DIR },
  { key: 'MAX_UPLOAD_MB', value: () => String(config.MAX_UPLOAD_MB) },
  { key: 'REPO_QUOTA_MB', value: () => String(config.REPO_QUOTA_MB) },
  { key: 'COMMAND_TIMEOUT_S', value: () => String(config.COMMAND_TIMEOUT_S) },
  { key: 'RATE_LIMIT_MAX', value: () => String(config.RATE_LIMIT_MAX) },
  { key: 'RATE_LIMIT_WINDOW_S', value: () => String(config.RATE_LIMIT_WINDOW_S) },
  { key: 'SESSION_TTL_MIN', value: () => String(config.SESSION_TTL_MIN) },
  { key: 'SESSION_REMEMBER_DAYS', value: () => String(config.SESSION_REMEMBER_DAYS) },
  { key: 'TRUST_PROXY', value: () => (config.TRUST_PROXY ? '1' : '0') },
  { key: 'DISABLE_PACMAN', value: () => (config.DISABLE_PACMAN ? '1' : '0') },
  { key: 'DISABLE_DEB', value: () => (config.DISABLE_DEB ? '1' : '0') },
  { key: 'DISABLE_RPM', value: () => (config.DISABLE_RPM ? '1' : '0') },
  { key: 'DISABLE_FLATPAK', value: () => (config.DISABLE_FLATPAK ? '1' : '0') },
  { key: 'LOG_LEVEL', value: () => config.LOG_LEVEL },
  { key: 'GPG_ROOT', value: () => config.GPG_ROOT },
  { key: 'ADMIN_USER', value: () => config.ADMIN_USER },
  { key: 'ADMIN_PASS', value: () => '', secret: true },
];

const ALGORITHM_NAMES: Record<number, string> = {
  1: 'RSA',
  16: 'ElGamal',
  17: 'DSA',
  18: 'ECDH',
  19: 'ECDSA',
  22: 'EdDSA',
};

function keyAlgorithm(repoId: string, fingerprint: string): string | null {
  const list = spawnSync(
    'gpg',
    ['--homedir', gpgHome(repoId), '--with-colons', '--list-keys', fingerprint],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    },
  );
  if (list.status !== 0) return null;
  const pub = list.stdout.split('\n').find((line) => line.startsWith('pub:'));
  if (!pub) return null;
  const fields = pub.split(':');
  const id = Number(fields[4] ?? 0);
  const name = ALGORITHM_NAMES[id];
  if (!name) return null;
  // The key length field is empty for ECC keys.
  return fields[3] ? `${name} (${fields[3]} bit)` : name;
}

const putSsoSchema = z.object({
  enabled: z.boolean().optional(),
  issuer: z.string().trim().url().max(512),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().min(1).max(512).optional(),
  scopes: z.string().max(255).optional(),
  // '' clears a nullable field; undefined leaves it untouched
  adminClaim: z.preprocess((v) => (v === '' ? null : v), z.string().max(128).nullable().optional()),
  adminValue: z.preprocess((v) => (v === '' ? null : v), z.string().max(128).nullable().optional()),
  autoCreate: z.boolean().optional(),
});

const testSsoSchema = z.object({ issuer: z.string().trim().url().max(512) });

function maskedSsoView() {
  const row = loadSsoConfig();
  return {
    exists: row !== null,
    enabled: ssoEnabled(),
    seededFromEnv: row?.seededFromEnv ?? false,
    issuer: row?.issuer ?? '',
    clientId: row?.clientId ?? '',
    scopes: row?.scopes ?? 'openid profile email',
    adminClaim: row?.adminClaim ?? null,
    adminValue: row?.adminValue ?? null,
    autoCreate: row?.autoCreate ?? true,
    // the secret is never echoed back — only whether one is on file
    hasSecret: Boolean(row?.clientSecret),
  };
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  // Every settings verb is admin-only.
  fastify.addHook('preHandler', async (request) => {
    requireAdmin(request);
  });

  fastify.get('/env', async () => ({
    success: true,
    data: envEntries.map((entry) => ({
      key: entry.key,
      value: entry.secret ? null : entry.value(),
      configured: entry.secret ? Boolean(config.ADMIN_PASS) : true,
      secret: entry.secret === true,
    })),
  }));

  fastify.get('/sso', async () => ({ success: true, data: maskedSsoView() }));

  fastify.put('/sso', async (request) => {
    const body = putSsoSchema.parse(request.body);
    const row = loadSsoConfig();
    if (!row && !body.clientSecret) {
      throw new AppError('BAD_REQUEST', 'client secret is required on first configuration', 400);
    }

    // The admin claim only means anything as a pair: both stay or both go.
    const providesClaim = body.adminClaim !== undefined;
    const providesValue = body.adminValue !== undefined;
    if (providesClaim !== providesValue) {
      throw new AppError('BAD_REQUEST', 'admin claim and value must be set together', 400);
    }

    const values = {
      enabled: body.enabled ?? row?.enabled ?? true,
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret: body.clientSecret ?? row?.clientSecret ?? null,
      scopes: body.scopes ?? row?.scopes ?? 'openid profile email',
      adminClaim: body.adminClaim ?? row?.adminClaim ?? null,
      adminValue: body.adminValue ?? row?.adminValue ?? null,
      autoCreate: body.autoCreate ?? row?.autoCreate ?? true,
    };

    if (row) {
      db.update(schema.ssoConfig)
        .set({ ...values, seededFromEnv: row.seededFromEnv })
        .where(eq(schema.ssoConfig.id, row.id))
        .run();
    } else {
      db.insert(schema.ssoConfig)
        .values({ id: 'default', ...values, seededFromEnv: false })
        .run();
    }
    clearDiscoveryCache();

    return { success: true, data: maskedSsoView() };
  });

  fastify.post('/sso/test', async (request) => {
    const body = testSsoSchema.parse(request.body);
    try {
      const discovery = await testDiscovery(body.issuer);
      return {
        success: true,
        data: { ok: true, authorizationEndpoint: discovery.authorization_endpoint },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: true, data: { ok: false, error: message } };
    }
  });

  fastify.get('/keys', async () => {
    const rows = db
      .select({
        repoId: schema.repos.id,
        repo: schema.repos.name,
        repoType: schema.repos.type,
        fingerprint: schema.gpgKeys.fingerprint,
        publicArmored: schema.gpgKeys.publicArmored,
        createdAt: schema.gpgKeys.createdAt,
      })
      .from(schema.repoKeys)
      .innerJoin(schema.gpgKeys, eq(schema.repoKeys.keyId, schema.gpgKeys.id))
      .innerJoin(schema.repos, eq(schema.repoKeys.repoId, schema.repos.id))
      .all();

    return {
      success: true,
      data: rows.map((row) => ({
        repo: row.repo,
        repoType: row.repoType,
        fingerprint: row.fingerprint,
        algorithm: keyAlgorithm(row.repoId, row.fingerprint),
        // epoch seconds, like every other API row the UI formats itself
        createdAt: row.createdAt,
        publicKey: row.publicArmored,
      })),
    };
  });
};

export default settingsRoutes;
