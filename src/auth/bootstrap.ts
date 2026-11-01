import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { hashPassword } from './password.js';
import { purgeExpiredSessions } from './sessions.js';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function bootstrapAdmin(): Promise<void> {
  purgeExpiredSessions();

  const admins = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.login, config.ADMIN_USER))
    .all();

  if (admins.length > 0) {
    return;
  }

  const password = config.ADMIN_PASS ?? randomBytes(16).toString('base64url');
  const generated = config.ADMIN_PASS === undefined;

  db.insert(schema.users)
    .values({
      id: randomUUID(),
      login: config.ADMIN_USER,
      passHash: await hashPassword(password),
      role: 'admin',
      createdAt: nowSeconds(),
    })
    .run();

  const admin = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.login, config.ADMIN_USER))
    .all()[0];
  if (!admin) {
    throw new Error('bootstrap: failed to create admin user');
  }

  if (generated) {
    process.stdout.write(
      `\n=== PACKRATTER ADMIN PASSWORD (save it, it will not be shown again) ===\n${password}\n===\n\n`,
    );
  }
}
