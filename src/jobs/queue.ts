import PQueue from 'p-queue';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { nowSeconds } from '../lib/time.js';
import { CommandError } from '../lib/exec.js';
import { formats, type RepoType } from '../formats/index.js';

const queues = new Map<string, PQueue>();

function queueFor(repoId: string, envId: string): PQueue {
  const key = `${repoId}:${envId}`;
  if (!queues.has(key)) {
    queues.set(key, new PQueue({ concurrency: 1 }));
  }
  return queues.get(key)!;
}

export async function enqueueRebuild(repoId: string, envId: string): Promise<string> {
  const jobId = randomUUID();
  db.insert(schema.jobs)
    .values({
      id: jobId,
      repoId,
      envId,
      kind: 'rebuild',
      status: 'pending',
      log: '',
      createdAt: nowSeconds(),
    })
    .run();

  const env = db.select().from(schema.envs).where(eq(schema.envs.id, envId)).all()[0];
  if (!env) {
    throw new Error('env not found');
  }

  const logText: { value: string } = { value: '' };
  const log = (line: string) => {
    logText.value += (logText.value ? '\n' : '') + line;
    db.update(schema.jobs).set({ log: logText.value }).where(eq(schema.jobs.id, jobId)).run();
  };

  void queueFor(repoId, envId).add(async () => {
    db.update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, jobId)).run();
    try {
      const repo = db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).all()[0];
      if (!repo) throw new Error('repo not found');
      await formats[repo.type as RepoType].rebuild(env, log);
      db.update(schema.packages)
        .set({ status: 'ready' })
        .where(eq(schema.packages.envId, env.id))
        .run();
      db.update(schema.jobs).set({ status: 'done' }).where(eq(schema.jobs.id, jobId)).run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(message);
      db.update(schema.jobs)
        .set({
          status: 'error',
          errorCode: err instanceof CommandError ? err.code : 'INTERNAL_ERROR',
          errorMessage: message,
        })
        .where(eq(schema.jobs.id, jobId))
        .run();
    }
  });

  return jobId;
}
