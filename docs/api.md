# API reference

All API responses use the envelope:

```json
{ "success": true, "data": {} }
```

or on error:

```json
{ "success": false, "error": { "code": "...", "message": "..." } }
```

Writes require a bearer token (`Authorization: Bearer <token>`). Public read endpoints are marked below.

## Health

### `GET /healthz` (public)

Returns service health.

```json
{ "status": "ok", "timestamp": "..." }
```

## Repositories

### `POST /api/v1/repos`

Create a repository. `type` can be `pacman` or `flatpak` (the latter requires `ENABLE_FLATPAK=1`).

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

## Keys and setup

### `GET /api/v1/repos/:repo/:env/gpg-public-key` (public)

Returns the armored GPG public key for the repository.

### `GET /api/v1/repos/:repo/:env/setup-snippet` (public)

Returns client configuration instructions for the repository type (pacman.conf snippet or flatpak remote-add commands).

## Jobs

### `GET /api/v1/jobs/:id` (public)

Get job status and log.

## Static serving

### `GET /r/:repo/:env/*` (public)

Serve repository files with format-appropriate cache headers. For example:

- Pacman: `*.db*`, `*.files*`, `*.sig` → `no-cache`; package files → immutable.
- Flatpak: `summary`, `summary.sig`, `summary.idx` → `no-cache`; OSTree objects → immutable.
