# Packratter

<img src="media/logo.png" alt="Packratter logo" width="160">

Host-only repository manager for `deb`, `rpm`, `pacman` and `flatpak` packages.

This is the **S1 Pacman** branch: repository creation, raw-body package upload, GPG-signed `repo-add` rebuilds, static serving under `/r/`, and a minimal SvelteKit UI at `/app`. See [`PLAN.md`](./PLAN.md) and [`STAGES.md`](./STAGES.md) for the full design and roadmap.

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
pnpm dev:all
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
| `pnpm dev` | Run backend with `tsx watch` |
| `pnpm dev:ui` | Run SvelteKit dev server |
| `pnpm dev:all` | Run backend + UI dev server together |
| `pnpm build` | Compile TypeScript to `dist/` and copy SQL migrations |
| `pnpm start` | Run compiled `dist/index.js` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
