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
- Full test suite (`RUN_FULL_TESTS=1`) drives real package managers and must only run in the toolchain container (`docker compose -f docker-compose.test.yml run --rm packratter-tests`); `test/setup.ts` enforces this. `pnpm test` is host-safe.
- Use `crypto.randomUUID()` and `crypto.randomBytes()` for IDs/secrets; no `nanoid`.
- Keep dependencies minimal.

## First-boot contract

If no users exist, the service creates the `ADMIN_USER` account. The password comes
from `ADMIN_PASS`; when unset, a strong password is generated and printed once on
stdout (never again). There is no boot-time API token — keys are managed per user in
the web UI.

## Changelog

`CHANGELOG.md` uses only these sections: **Changes**, **Fixes**, **Security**, and **Updates** (reserved for dependency updates). Omit empty sections. Entries should be user-facing; avoid implementation details, stage labels, and internal architecture speak.

## Stages

See `STAGES.md`. Current progress: **S7 complete** (SSO/OIDC as an additional login
method, per-repo access grants (maintainer/viewer), claim-managed admin role — shipped
in 0.7.0 alongside the flatpak and package-list improvements). S8 ops & audit hardening
is next.
