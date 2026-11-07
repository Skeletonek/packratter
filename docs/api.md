# API reference

All API responses use the envelope:

```json
{ "success": true, "data": {} }
```

or on error:

```json
{ "success": false, "error": { "code": "...", "message": "..." } }
```

In URLs, `:repo` is the repository name and `:env` the environment name (e.g. `/r/myrepo/stable/...`), not internal ids.

## Authentication

Everything under `/api/` requires a signed-in identity — reads included. The web UI
signs in with a session cookie; script consumers use a per-user API key. `/r/*`,
`/healthz` and the static UI shell stay public.

- **Session:** `POST /api/v1/auth/login` sets a httpOnly `SameSite=Lax` cookie
  (`Secure` in production — serve the UI behind HTTPS). Without "remember this
  device" a session lasts `SESSION_TTL_MIN` (default 24 h); with it, both cookie and
  server session last `SESSION_REMEMBER_DAYS` (default 7 days).
- **API keys:** `Authorization: Bearer <token>`. Each user manages their own keys
  (create/revoke via UI or `POST /api/v1/keys`); the plaintext token is shown once
  at creation.

Admin-only endpoints answer `403 FORBIDDEN` for plain users; invalid credentials
or an expired session answer `401 UNAUTHORIZED`.

### `POST /api/v1/auth/login` (public)

```json
{ "login": "admin", "password": "...", "remember": true }
```

`remember` is optional. On success the response contains the user and the cookie is set:

```json
{ "success": true, "data": { "login": "admin", "role": "admin", "email": null } }
```

### `POST /api/v1/auth/logout` (public)

Deletes the current session and clears the cookie.

### `GET /api/v1/me`

The signed-in user: `{ id, login, email, role, createdAt }`.

### `PATCH /api/v1/me`

Update own profile. `login` (renaming yourself), `displayName` and `email` are each
optional; an empty `displayName`/`email` clears it. The response contains the updated
user.

### `POST /api/v1/me/password`

Change own password: `{ "current": "...", "next": "..." }` (`next` must be at least 8
characters). Other devices keep their sessions.

### `GET /api/v1/keys`

List own API keys (`{ id, prefix, createdAt }`).

### `POST /api/v1/keys`

Create an API key. The response contains the plaintext `token` exactly once:

```json
{ "success": true, "data": { "id": "...", "prefix": "pkt_abcd1234", "token": "pkt_..." } }
```

### `DELETE /api/v1/keys/:id`

Revoke one of your own keys. Revocation is effective immediately.

### `GET /api/v1/users` (admin)

List users.

### `POST /api/v1/users` (admin)

```json
{ "login": "alice", "email": "alice@example.com", "role": "user", "password": "..." }
```

`password`, `email` and `role` are optional (`role` defaults to `user`). An omitted
password is generated and returned once in the response, same one-time contract as the
bootstrap superuser.

### `PATCH /api/v1/users/:id` (admin)

Update `login`, `email`, `displayName` and/or `role`. Demoting the last admin answers
`409 CONFLICT`. Renamed logins keep sessions and API keys intact.

### `POST /api/v1/users/:id/password` (admin)

Reset a user's password. A new generated password is returned in the response —
shown only once (same contract as account creation).

### `DELETE /api/v1/users/:id` (admin)

Delete a user. Attempting to delete yourself or the last admin answers `409 CONFLICT`.
The user's API keys and sessions are removed with them.

## Health

### `GET /healthz` (public)

Returns service health.

```json
{ "status": "ok", "timestamp": "..." }
```

## Toolchain

### `GET /api/v1/toolchain`

Which native package-manager tools are installed on the server. Each key is a repo
type, `ok` means the type is fully usable, `missing` names the exact absent commands:

```json
{
  "success": true,
  "data": {
    "pacman": { "ok": false, "missing": ["repo-add", "bsdtar"] },
    "deb": { "ok": true, "missing": [] },
    "rpm": { "ok": true, "missing": [] },
    "flatpak": { "ok": true, "missing": [] }
  }
}
```

Creating a repo of a type with `missing` tools answers `409 TOOLCHAIN_MISSING`, and the
web UI warns about disabled types with the same information.

An ecosystem can also be switched off explicitly (independent of installed tools) —
`DISABLE_PACMAN=1` / `DISABLE_DEB=1` / `DISABLE_RPM=1` / `DISABLE_FLATPAK=1`. A
type disabled this way reports `disabledByConfig: true`, rejects creation and
uploads with `409 TYPE_DISABLED`, and produces **no** warning banner: it was a
deliberate choice.

## Repositories

### `POST /api/v1/repos`

Create a repository. `type` can be `pacman`, `deb`, `rpm`, or `flatpak`.

Request:

```json
{ "name": "myrepo", "type": "pacman", "env": "stable" }
```

`env` (the first environment's name) is optional and defaults to `stable`.
To sign with your own GPG key instead of a generated one, pass `privateKey`
(armored private key block) and, for passphrase-protected keys, `passphrase`:

```json
{
  "name": "myrepo",
  "type": "pacman",
  "privateKey": "-----BEGIN PGP PRIVATE...",
  "passphrase": "..."
}
```

An importable key (secret key present, passphrase correct) is required —
otherwise the repository is not created and `400 BAD_REQUEST` explains why.

Response: `201 Created`

```json
{
  "success": true,
  "data": {
    "id": "<repo-id>",
    "name": "myrepo",
    "type": "pacman",
    "envs": [{ "id": "<env-id>", "name": "stable" }]
  }
}
```

### `POST /api/v1/repos/:repo/key` (admin)

Replace the repository's signing key (rotation). The new key is validated on
import; the old one stops signing but stays downloadable by fingerprint at
`/r/<repo>/<env>/gpg-public-key/<fingerprint>`. Metadata for every environment
is re-signed with the new key.

Request:

```json
{ "privateKey": "-----BEGIN PGP PRIVATE...", "passphrase": "..." }
```

Answers `409 REPO_BUSY` while rebuild jobs are pending or running, `400
BAD_REQUEST` when the key is not importable. Response: `200 OK` with
`{ "fingerprint": "...", "jobIds": [...] }`.

### `GET /api/v1/repos`

List all repositories with their environments and package counts:

```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "name": "myrepo",
      "type": "pacman",
      "envs": [{ "id": "...", "name": "stable" }],
      "packageCount": 3
    }
  ]
}
```

### `DELETE /api/v1/repos/:repo` (admin)

Delete a repository with all its environments, packages, GPG keys and on-disk data.
Answers `409 REPO_BUSY` while rebuild jobs for it are pending or running.

### `GET /api/v1/repos/:repo`

List all repositories.

### `GET /api/v1/repos/:repo`

Get a single repository, including its environments.

## Packages

### `GET /api/v1/repos/:repo/:env/packages`

List packages in an environment. Supports `?q=` search and `?page=` pagination.

### `PUT /api/v1/repos/:repo/:env/packages`

Upload a package or bundle. The request body is the raw file bytes. Returns the uploaded filename and a rebuild job ID.

Response: `202 Accepted`

```json
{
  "success": true,
  "data": { "jobId": "<job-id>", "filename": "..." }
}
```

### `DELETE /api/v1/repos/:repo/:env/packages/:filename`

Delete a package and enqueue a rebuild.

## Environments

### `POST /api/v1/repos/:repo/envs`

Create an environment (e.g. `testing`). `name` must match `[a-z0-9-]+` and be unique within the repo.

Request:

```json
{ "name": "testing" }
```

Response: `201 Created`

### `PATCH /api/v1/repos/:repo/envs/:env` (admin)

Rename an environment. Client URLs change with the name, so update downstream
configurations after renaming (the deb metadata directory is moved, everything else
is name-independent).

### `DELETE /api/v1/repos/:repo/envs/:env` (admin)

Delete an environment with its packages and metadata. The last environment of a
repository cannot be deleted (`409 CONFLICT`), and both verbs answer `409 REPO_BUSY`
while rebuild jobs for the repository are pending or running.

### `GET /api/v1/repos/:repo/diff`

Compare two environments: `?from=<env>&to=<env>`. Returns package lists `onlyInFrom`, `onlyInTo`, and `different` (same filename, different content).

### `POST /api/v1/repos/:repo/promote`

Promote packages from one environment to another. Packages already present in the target (same filename) are skipped. Returns a rebuild job for the target env.

Request:

```json
{ "from": "testing", "to": "stable", "filenames": ["pkg-1.0.0-1-x86_64.pkg.tar.zst"] }
```

Omit `filenames` to promote everything. Response: `202 Accepted`

```json
{
  "success": true,
  "data": { "jobId": "<job-id>", "promoted": 1, "skipped": 0 }
}
```

`jobId` is `null` when nothing was promoted and no rebuild was needed.

## Keys and setup

Setup snippets reference `GET /r/:repo/:env/gpg-public-key` (below), so client
machines never need credentials.

### `GET /api/v1/repos/:repo/:env/setup-snippet`

Returns client configuration instructions for the repository type (pacman.conf block, apt sources.list entry, dnf .repo file, or flatpak remote-add commands).

## Jobs

### `GET /api/v1/jobs`

List job history, newest first. Filter with `?repo=<name>` (and `&env=<name>`); paginate with `?page=`.

### `GET /api/v1/jobs/:id`

Get job status and log. The log is written incrementally while the job runs.

### `POST /api/v1/jobs/:id/retry`

Re-run a finished job's rebuild. Returns `202 Accepted` with a new `jobId`.

## Static serving

### `GET /r/:repo/:env/*` (public)

Serve repository files with format-appropriate cache headers. For example:

- Pacman: `*.db*`, `*.files*`, `*.sig` → `no-cache`; package files → immutable.
- Deb: `dists/**` metadata → `no-cache`; `pool/*.deb` → immutable.
- RPM: `repodata/*` → `no-cache`; `*.rpm` → immutable.
- Flatpak: `summary`, `summary.sig`, `summary.idx` → `no-cache`; OSTree objects → immutable.

### `GET /r/:repo/:env/gpg-public-key` (public)

Returns the armored GPG public key of the repository as plain text. This is the URL
that dnf's `gpgkey=` and the setup snippets use.

### `GET /r/:repo/:env/gpg-public-key/:fingerprint` (public)

Returns the armored public key of any key ever used by the repository,
including replaced ones — for clients transitioning after a key rotation.
