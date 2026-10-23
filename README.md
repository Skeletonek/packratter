# Packratter

<img src="media/logo.png" alt="Packratter logo" width="160">

Host-only repository manager for `deb`, `rpm`, `pacman` and `flatpak` packages.

**Currently very much work in progress.**

As of now it supports pacman and flatpak repositories (with `ENABLE_FLATPAK=1` env). Create repos, upload packages or bundles then serve everything under `/r/`. Packratter will manage all maintenance stuff like GPG signing and metadata rebuilding. 

The web UI lives at `/app` and is styled with Bootstrap 5, including light and dark themes.

## Quick start

### Local

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

### Docker / Podman

```bash
cp .env.example .env
# edit ADMIN_USER and ADMIN_PASS
docker compose up --build
```

The image is based on Fedora 44 with Node 24.21.0 installed from the official tarball.

## Documentation

- [Pacman setup](docs/pacman.md)
- [Flatpak setup](docs/flatpak.md)
- [API reference](docs/api.md)

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
| `pnpm test` | Fast unit tests |
| `pnpm test:full` | Full test suite, including real `bsdtar`/`repo-add` and flatpak toolchain. Recommended to run only in docker environment |

## LLM Usage

This project uses AI to help generate code, and a significant portion of the codebase is AI-generated. However, reviews and quality testing are done entirely by a human. New features are also planed by human with the help of AI to best suit the current project codebase.
