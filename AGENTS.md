# Packratter — Agent Notes

Project-specific guidance.

## Stack

- TypeScript 5.x, ESM, strict mode.
- Fastify 5 for HTTP.
- `node:sqlite` + Drizzle ORM (`drizzle-orm/node-sqlite`). Do **not** add `better-sqlite3`.
- Plain SQL migrations in `src/db/migrations/*.sql`, applied at boot.
- argon2 for password and API-token hashing.
- vitest for tests.

## Conventions

- Keep files small and focused. One responsibility per module.
- Use native tools for metadata generation; TS only reads headers for display.
- Never log secrets or full API tokens. Token hashes are stored; plaintext tokens are shown exactly once at bootstrap.
- Use `LC_ALL=C` when shelling out to native tools.
- Use `crypto.randomUUID()` and `crypto.randomBytes()` for IDs/secrets; no `nanoid`.
- Keep dependencies minimal.

## First-boot contract

If no users exist, the service creates the `ADMIN_USER` account from the environment and prints a single bearer token. The token is stored as a hash and is never printed again.

## Stages

See `STAGES.md`. Current progress: **S0 complete**. Do not jump ahead into UI, uploads or GPG until S1 starts.
