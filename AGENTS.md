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

## Changelog

`CHANGELOG.md` uses only these sections: **Changes**, **Fixes**, **Security**, and **Updates** (reserved for dependency updates). Omit empty sections. Entries should be user-facing; avoid implementation details, stage labels, and internal architecture speak.

## Temporary flags

`ENABLE_FLATPAK` gates flatpak repo creation while the OSTree-over-HTTP path is proven in real use. Remove it once flatpak is stable.

## Stages

See `STAGES.md`. Current progress: **S2 complete** (flatpak bundle import + GPG-signed OSTree summary + serve + real `flatpak remote-add` client verification, gated by `ENABLE_FLATPAK=1`).
