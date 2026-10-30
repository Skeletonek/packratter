import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';

// Prebuilt fixture: flatpak build-init requires the org.freedesktop.Platform
// runtime to be installed, which neither the host nor the toolchain container
// should have to provide. Packratter only imports and serves bundles, so the
// bundle contents are irrelevant.
const fixturePath = fileURLToPath(
  new URL('./fixtures/org.test.App-master.flatpak', import.meta.url),
);

let token = '';
let server: FastifyInstance;
let flatpakRepoId = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  applyMigrations();
  await bootstrapAdmin();
  const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
  if (!admin) throw new Error('admin user missing');

  const { token: generated, prefix, hash } = await generateToken();
  db.insert(schema.tokens)
    .values({
      id: randomUUID(),
      userId: admin.id,
      prefix,
      hash,
      scopes: 'admin',
      createdAt: Math.floor(Date.now() / 1000),
    })
    .run();
  token = generated;

  server = buildServer();
});

describe.skipIf(process.env.RUN_FULL_TESTS !== '1')('Flatpak repos', () => {
  it('creates a flatpak repo with the implicit stable env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: auth(),
      payload: { name: 'flatpak-test-repo', type: 'flatpak' },
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.type).toBe('flatpak');
    expect(json.data.envs).toEqual([expect.objectContaining({ name: 'stable' })]);
    flatpakRepoId = json.data.id;
  });

  it('returns a usable flatpak setup snippet', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${flatpakRepoId}/stable/setup-snippet`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const snippet = res.json().data;
    expect(snippet).toContain('flatpak remote-add');
    expect(snippet).toContain('/flatpak/ostree/');
    expect(snippet).toContain('flatpak install');
  });

  it('rejects an invalid bundle with VALIDATION_ERROR', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${flatpakRepoId}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('not a flatpak bundle'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('imports a bundle, rebuilds, and serves summary/signature files', async () => {
    const bundle = readFileSync(fixturePath);

    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${flatpakRepoId}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: bundle,
    });

    expect(uploadRes.statusCode).toBe(202);
    const uploadJson = uploadRes.json();
    expect(uploadJson.success).toBe(true);
    const jobId = uploadJson.data.jobId;
    expect(typeof jobId).toBe('string');

    let job: { status: string; log: string } | null = null;
    for (let i = 0; i < 60; i++) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/jobs/${jobId}`,
        headers: auth(),
      });
      job = res.json().data;
      if (job?.status === 'done' || job?.status === 'error') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(job?.status).toBe('done');

    const summaryRes = await server.inject({
      method: 'GET',
      url: `/r/${flatpakRepoId}/stable/flatpak/ostree/summary`,
    });
    expect(summaryRes.statusCode).toBe(200);

    const summarySigRes = await server.inject({
      method: 'GET',
      url: `/r/${flatpakRepoId}/stable/flatpak/ostree/summary.sig`,
    });
    expect(summarySigRes.statusCode).toBe(200);
  });
});
