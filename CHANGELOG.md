# Changelog

## 0.1.0 — 2026-10-12

### Added

- S0 foundation: Fastify 5 server, `node:sqlite` + Drizzle ORM, admin bootstrap, argon2 password/token hashing.
- S1 Pacman support:
  - Create/list/delete pacman repos with a default `stable` environment.
  - Raw-body package upload via `PUT /api/v1/repos/:repo/:env/packages`.
  - Automatic `repo-add` rebuild queue with GPG-signed `.db`, `.files`, and package signatures.
  - Public GPG public key and setup snippet endpoints.
  - Static serving under `/r/:repo/:env/*` with env-name to env-UUID translation.
- Minimal SvelteKit 2 static SPA at `/app`:
  - Repo list, create repo, repo detail with upload/package/job views.
  - Project logo/favicon in header, footer with version and build time.
  - Native `<dialog>` error popups with backend error codes and messages.
- `pnpm dev:all` script to run backend and UI dev servers together.
- Regression tests covering `$page`/`$app/stores` UI contract, env-name API routes, content-type parser, setup snippet, and full package upload → rebuild → static-serve flow.

### Fixed

- Backend env lookup now matches `envs.name` instead of `envs.id`.
- `BASE_URL=''` from the shell no longer crashes config parsing in tests.
- UI upload now sends `Content-Type: application/octet-stream` and handles `application/zstd` etc. on the backend.
- Generic 500 responses now include the real error message instead of a static "Internal server error".
- `enqueueRebuild` is now awaited so the returned `jobId` is a real UUID.
- GPG signing no longer hangs waiting for a passphrase; relative `GPG_ROOT`/`DATA_DIR` paths are resolved to absolute paths before spawning tools.
- Setup snippet uses correct `pacman-key` commands and the repo ID in the `/r/` URL.

### Changed

- Host port mapping changed to `5000:8080` in `docker-compose.yml` and docs.
- `BASE_URL` is now read from config and used in setup snippets.
