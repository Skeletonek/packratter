# Packratter

<img src="media/logo.png" alt="Packratter logo" width="160">

Host-only repository manager for `deb`, `rpm`, `pacman` and `flatpak` packages.

This is the **S0 foundation** branch: Fastify 5, `node:sqlite` + Drizzle, the full v1 schema, admin bootstrap, and a `/healthz` endpoint. See [`PLAN.md`](./PLAN.md) and [`STAGES.md`](./STAGES.md) for the full design and roadmap.

## Quick start (local)

```bash
cp .env.example .env
# edit ADMIN_USER and ADMIN_PASS
pnpm install
pnpm dev
```

The bootstrap API token is printed once on first startup. Check health with:

```bash
curl http://localhost:8080/healthz
```

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
| `pnpm dev` | Run with `tsx watch` |
| `pnpm build` | Compile TypeScript to `dist/` and copy SQL migrations |
| `pnpm start` | Run compiled `dist/index.js` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
