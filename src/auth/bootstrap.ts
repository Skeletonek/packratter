import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { hashPassword } from './password.js';
import { generateToken } from './tokens.js';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function bootstrapAdmin(): Promise<void> {
  const admins = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.login, config.ADMIN_USER))
    .all();

  let admin = admins[0];
  if (!admin) {
    db.insert(schema.users)
      .values({
        id: randomUUID(),
        login: config.ADMIN_USER,
        passHash: await hashPassword(config.ADMIN_PASS),
        role: 'admin',
        createdAt: nowSeconds(),
      })
      .run();
    const created = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, config.ADMIN_USER))
      .all();
    admin = created[0];
    if (!admin) {
      throw new Error('bootstrap: failed to create admin user');
    }
  }

  const existingTokens = db.select().from(schema.tokens).all();
  if (existingTokens.length === 0) {
    const { token, prefix, hash } = await generateToken();
    db.insert(schema.tokens)
      .values({
        id: randomUUID(),
        userId: admin.id,
        prefix,
        hash,
        scopes: 'admin',
        createdAt: nowSeconds(),
      })
      .run();

    process.stdout.write(
      `\n=== PACKRATTER BOOTSTRAP TOKEN (save it, it will not be shown again) ===\n${token}\n===\n\n`,
    );
  }
}
