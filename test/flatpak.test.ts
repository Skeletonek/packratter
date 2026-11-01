import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { buildFlatpakBundle, waitForJob } from './helpers.js';

let token = '';
let server: FastifyInstance;
let flatpakRepoName = '';

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
    flatpakRepoName = json.data.name;
  });

  it('returns a usable flatpak setup snippet', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${flatpakRepoName}/stable/setup-snippet`,
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
      url: `/api/v1/repos/${flatpakRepoName}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('not a flatpak bundle'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('imports a bundle, rebuilds, and serves summary/signature files', async () => {
    const bundle = buildFlatpakBundle();

    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${flatpakRepoName}/stable/packages`,
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
      url: `/r/${flatpakRepoName}/stable/flatpak/ostree/summary`,
    });
    expect(summaryRes.statusCode).toBe(200);

    const summarySigRes = await server.inject({
      method: 'GET',
      url: `/r/${flatpakRepoName}/stable/flatpak/ostree/summary.sig`,
    });
    expect(summarySigRes.statusCode).toBe(200);
  });

  it('promotes a bundle between envs', async () => {
    const envRes = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${flatpakRepoName}/envs`,
      headers: auth(),
      payload: { name: 'testing' },
    });
    expect(envRes.statusCode).toBe(201);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${flatpakRepoName}/promote`,
      headers: auth(),
      payload: { from: 'stable', to: 'testing' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ jobId: expect.any(String), promoted: 1, skipped: 0 });
    const job = await waitForJob(server, auth(), res.json().data.jobId);
    expect(job.status).toBe('done');

    const summary = await server.inject({
      method: 'GET',
      url: `/r/${flatpakRepoName}/testing/flatpak/ostree/summary`,
    });
    expect(summary.statusCode).toBe(200);

    const sig = await server.inject({
      method: 'GET',
      url: `/r/${flatpakRepoName}/testing/flatpak/ostree/summary.sig`,
    });
    expect(sig.statusCode).toBe(200);
  });
});
