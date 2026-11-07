# Changelog

## 0.8.0 — 2026-11-06

### Changes

- Audit trail of admin and destructive actions.
- Session list on the Account page.
- API keys can expire
- Two-factor sign-in for local accounts: authenticator apps (TOTP) and security keys (WebAuthn). 
- Old jobs and audit entries are cleaned up automatically
- SSO can require verified emails before linking accounts
- New documentation: production checklist, signing keys, two-factor auth.

### Security

- Admin password reset now also removes security keys.
- Authenticator codes cannot be replayed
- Pacman metadata can no longer write outside the repository directory.
- The web UI path no longer reveals whether server paths exist.
- Internal error details are no longer sent to clients.

## 0.7.0 — 2026-11-02

### Changes

- Flatpak packages publish under a branch named after their environment.
- Flatpak branch naming is configurable in repository settings.
- Renaming a flatpak environment moves published packages to the new branch name.
- Package lists sort by name, then highest version first, then architecture.
- Package lists gained a search box.
- The jobs list shows a date for each job.
- Environment rename and delete moved into the settings danger zone.
- Setup snippets contain only repository setup commands.
- SSO sign-in added as an additional login method.
- Repositories gained per-user access: maintainer can publish, viewer can browse.
- A settings page adds an environment overview, user management, OIDC configuration
  and a GPG key overview.

### Fixes

- Flatpak packages show their version and architecture.
- The error dialog has an opaque background again.

## 0.6.1 — 2026-11-01

### Changes

- The production container now runs as a non-root user.
- Backup and restore documentation added (`docs/backup.md`).

### Security

- An admin password reset now signs that user's sessions out everywhere.
- New `TRUST_PROXY` setting keys rate limiting on real client IPs behind a reverse proxy.

### Fixes

- Deleting a repository now returns to the repositories page with a confirmation banner.
- Deleting or renaming an environment shows a confirmation banner.
- The production image build no longer fails on unapproved dependency build scripts.

## 0.6.0 — 2026-11-01

### Changes

- The API now requires signing in — reads included, via a login/password session for the web UI and per-user API keys for scripts.
- Each user manages their own API keys — no more shared bootstrap key.
- Admins can create, edit, and delete team accounts in a new Users page.
- The Account page covers profile changes, password changes, and API keys.
- The per-repo public key is now served publicly under `/r/`.
- Ecosystems with missing server tooling are disabled and reported in a UI banner.
- Ecosystems can be switched off deliberately with `DISABLE_<TYPE>=1`.
- Repositories can be deleted; environments can be renamed or deleted (admin-only).
- The first environment name is now selectable at creation and defaults to `stable`.
- The repositories page gains a list view showing environments and package counts.
- A custom UI color theme derived from the mascot.
- Admins can reset a user's password with a one-time generated value.

### Security

- Session cookies are httpOnly, `SameSite=Lax`, and `Secure` in production.
- Session ids are stored hashed, so a database copy cannot hijack sessions.
- `ADMIN_PASS` is optional — the generated first-boot admin password is printed once.
- No API token is printed at startup anymore.

## 0.5.1 — 2026-11-01

### Fixes

- Rebuilding the server no longer nests migration files in `dist/`, leaving new migrations unapplied.

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
