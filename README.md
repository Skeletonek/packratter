# Packratter

<img src="media/logo.png" alt="Packratter logo" width="160">

Host-only repository manager for `deb`, `rpm`, `pacman` and `flatpak` packages.

**Currently very much work in progress.**

As of now it supports pacman, deb, rpm and flatpak repositories (flatpak with `ENABLE_FLATPAK=1` env). Create repos, upload packages or bundles then serve everything under `/r/`. Packratter will manage all maintenance stuff like GPG signing and metadata rebuilding.

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

### Development in Docker

Install and build on the host, then the container runs the compiled server against the exact base the production image uses:

```bash
pnpm install && pnpm build
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f
```

Data and repositories live in `./data` / `./data/keys` on the host. After code changes, rebuild and restart:

```bash
pnpm build
docker compose -f docker-compose.dev.yml restart
```

Stop the stack with `docker compose -f docker-compose.dev.yml down`. Prefer `up -d` over a foreground `up` — podman-compose 1.6 prints a harmless-looking `exec.fifo` error when `up` attaches to an already-running container.

### Testing in Docker

The full test suite (including the deb/rpm toolchain) runs inside the same container so your host needs nothing extra:

```bash
docker compose -f docker-compose.test.yml run --rm packratter-tests
```

Test dependencies live inside dedicated volumes and are installed automatically on the first run; later runs reuse them.

## Documentation

- [Pacman setup](docs/pacman.md)
- [Deb setup](docs/deb.md)
- [RPM setup](docs/rpm.md)
- [Flatpak setup](docs/flatpak.md)
- [API reference](docs/api.md)
- [Toolchain requirements](docs/toolchain.md)

## Scripts

| Script            | Purpose                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`        | Run backend + UI dev server together                                                                                              |
| `pnpm dev:server` | Run backend with `tsx watch`                                                                                                      |
| `pnpm dev:ui`     | Run SvelteKit dev server                                                                                                          |
| `pnpm build`      | Compile TypeScript to `dist/` and copy SQL migrations                                                                             |
| `pnpm start`      | Run compiled `dist/index.js`                                                                                                      |
| `pnpm typecheck`  | `tsc --noEmit`                                                                                                                    |
| `pnpm lint`       | ESLint                                                                                                                            |
| `pnpm test`       | Fast unit tests                                                                                                                   |
| `pnpm test:full`  | Full test suite, including real `bsdtar`/`repo-add`, flatpak and deb/rpm toolchain. Recommended to run only in docker environment |

## LLM Usage

This project uses AI to help generate code, and a significant portion of the codebase is AI-generated. However, reviews and quality testing are done entirely by a human. New features are also planed by human with the help of AI to best suit the current project codebase.
