# API reference

All API responses use the envelope:

```json
{ "success": true, "data": {} }
```

or on error:

```json
{ "success": false, "error": { "code": "...", "message": "..." } }
```

All reads are public. Writes require a bearer token (`Authorization: Bearer <token>`).

In URLs, `:repo` is the repository name and `:env` the environment name (e.g. `/r/myrepo/stable/...`), not internal ids.

## Health

### `GET /healthz` (public)

Returns service health.

```json
{ "status": "ok", "timestamp": "..." }
```

## Repositories

### `POST /api/v1/repos`

Create a repository. `type` can be `pacman`, `deb`, `rpm`, or `flatpak` (the latter requires `ENABLE_FLATPAK=1`).

Request:

```json
{ "name": "myrepo", "type": "pacman" }
```

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

### `GET /api/v1/repos` (public)

List all repositories.

### `GET /api/v1/repos/:repo` (public)

Get a single repository, including its environments.

## Packages

### `GET /api/v1/repos/:repo/:env/packages` (public)

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

### `GET /api/v1/repos/:repo/diff` (public)

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

### `GET /api/v1/repos/:repo/:env/gpg-public-key` (public)

Returns the armored GPG public key for the repository.

### `GET /api/v1/repos/:repo/:env/setup-snippet` (public)

Returns client configuration instructions for the repository type (pacman.conf block, apt sources.list entry, dnf .repo file, or flatpak remote-add commands).

## Jobs

### `GET /api/v1/jobs` (public)

List job history, newest first. Filter with `?repo=<name>` (and `&env=<name>`); paginate with `?page=`.

### `GET /api/v1/jobs/:id` (public)

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
