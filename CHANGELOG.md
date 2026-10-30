# Changelog

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
