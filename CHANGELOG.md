# Changelog

## 0.2.0 — 2026-10-23

### Changes

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
