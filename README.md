# Packratter

<img src="media/logo.png" alt="Packratter logo" width="160">

Host-only repository manager for `deb`, `rpm`, `pacman` and `flatpak` packages.

Currently supports pacman repositories: create repos, upload packages, automatically rebuild and GPG-sign the database, then serve everything under `/r/`. The web UI lives at `/app` and is styled with Bootstrap 5, including light and dark themes.

## Quick start (local)

```bash
cp .env.example .env
# edit ADMIN_USER and ADMIN_PASS
pnpm install
pnpm dev
```

The bootstrap API token is printed once on first startup. Open the UI at `http://localhost:5000/app` or check health with:

```bash
curl http://localhost:5000/healthz
```

### Run backend + UI together

```bash
pnpm dev
```

This starts the backend on `PORT` (default `5000`) and the SvelteKit dev server with an `/api/v1` + `/r` proxy.

### Upload a pacman package

```bash
TOKEN="<bootstrap-token>"

# create a pacman repo
curl -X POST http://localhost:5000/api/v1/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","type":"pacman"}'

# upload (the filename is derived from .PKGINFO)
curl -T mypackage.pkg.tar.zst \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  http://localhost:5000/api/v1/repos/<repo-id>/stable/packages

# poll the rebuild job
curl http://localhost:5000/api/v1/jobs/<job-id>
```

After the rebuild job finishes, copy the setup snippet from the repo page (or `GET /api/v1/repos/<repo-id>/stable/setup-snippet`) into `/etc/pacman.conf`.

## UI

Open `http://localhost:5000/app`. The UI uses Bootstrap 5 with a light/dark theme toggle, tabbed repo management, copy-to-clipboard setup snippets, and expandable error details.

## Docker / Podman

```bash
cp .env.example .env
# edit ADMIN_USER and ADMIN_PASS
podman compose up --build
```

The image is based on Fedora 44 with Node 24.21.0 installed from the official tarball.

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Run backend + UI dev server together |
| `pnpm dev:server` | Run backend with `tsx watch` |
| `pnpm dev:ui` | Run SvelteKit dev server |
| `pnpm build` | Compile TypeScript to `dist/` and copy SQL migrations |
| `pnpm start` | Run compiled `dist/index.js` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
