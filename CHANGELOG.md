# Changelog

## 0.5.1 — 2026-11-01

### Fixes

- Rebuilding the server no longer nests migration files when `dist/` already exists, which could leave new migrations unapplied on startup.

## 0.5.0 — 2026-11-01

### Changes

- Uploads are now capped by `MAX_UPLOAD_MB` per file and `REPO_QUOTA_MB` per repository.
- Metadata rebuild commands are now killed after `COMMAND_TIMEOUT_S` instead of hanging a job forever.
- Failed jobs now show a structured error code and message in the jobs list.
- Browsers now receive styled HTML error pages instead of raw JSON.
- Flatpak support is no longer gated behind `ENABLE_FLATPAK`.

### Security

- Updated Node.js to 24.22.2, addressing the Node2Shell vulnerability (CVE-2026-111497).
- Write API requests are now rate limited (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_S`).

### Fixes

- Pacman packages now keep their original `name-ver-rel-arch` filenames after upload.

## 0.4.0 — 2026-10-30

### Changes

- Repository URLs now use the repo name instead of its internal id
- Repositories can now have multiple environments (like `testing` and `stable`)
- A new Promote tab moves packages between environments
- The repo page now shows job history with live logs and a Retry button for finished jobs.

### Security

- Write API requests now require a bearer token, settable in the web UI via the key button in the top bar.

### Fixes

- Invalid request payloads now return `400 VALIDATION_ERROR` instead of a generic 500.

## 0.3.0 — 2026-10-30

### Changes

- Added deb and rpm repository support with apt- and dnf-compatible metadata and client setup snippets.

## 0.2.0 — 2026-10-23

### Changes

- Added flatpak bundle import and serve, gated by `ENABLE_FLATPAK=1`.
- Flatpak repos rebuild a GPG-signed OSTree repo that `flatpak remote-add` and `flatpak install` can consume.
- The web UI now lets you choose between pacman and flatpak when creating a repo.
- New Bootstrap-based UI with light and dark themes.
- Repo detail page now uses tabs for Upload, Packages, Jobs, and Setup.
- Added a copy-to-clipboard button for the setup snippet.
- Job logs and error details are now expandable in the UI.
- Renamed dev scripts: `pnpm dev` now starts the backend and UI together; use `pnpm dev:server` for backend only.

## 0.1.0 — 2026-10-12

### Changes

- Initial release: create and manage pacman repositories from the web UI.
- Upload packages, automatically rebuild the repository database, and sign everything with a per-repo GPG key.
- Serve repositories under `/r/` for use with pacman.
- Public GPG key and setup snippet endpoints make client configuration easy.
- Run backend and UI together with `pnpm dev`.
