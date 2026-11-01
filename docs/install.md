# Install

Packratter ships as a single container image with all backend tooling (GPG and the
repo tools for every supported format) preinstalled. The recommended install is
Docker — or Podman — Compose pulling the prebuilt image; no build steps needed.

## Requirements

- Docker Engine or Podman with the compose plugin (`docker compose` / `podman compose`).
- ~3 GB of free disk space (image plus data).
- A directory for persistent data — database, repositories, GPG keys: `./data` below.

## 1. Create the directory and configuration

```bash
mkdir -p ~/packratter && cd ~/packratter
```

Create a `.env` file next to the compose file (step 2):

```dotenv
ADMIN_USER=yourname

# Public base URL used in the setup snippets the UI shows to repo clients.
BASE_URL=https://packratter.example.com

# Set 1 when behind a TLS-terminating reverse proxy (see step 5).
#TRUST_PROXY=1
```

`ADMIN_USER` is required — it names the admin account created on first boot. `ADMIN_PASS`
is optional: when unset, a strong password is generated and printed once in the first
startup log (see step 3).

The full variable list — upload limits, per-repo quotas, session lifetimes, per-ecosystem
`DISABLE_*` switches — is documented in [`.env.example`](../.env.example) in the repository.

## 2. Compose file

Save as `compose.yaml` (name irrelevant; any compose file works):

```yaml
services:
  packratter:
    image: registry.gitlab.com/skeletonek/packratter:latest
    container_name: packratter
    ports:
      - '8080:8080'
    volumes:
      - ./data:/data
    env_file:
      - .env
    restart: unless-stopped
```

Everything persistent lives in `./data` — point a backup routine at it (see
[backups](backup.md)). Data directory ownership is fixed up automatically at startup,
including rootless Podman bind mounts.

A different host port: change the left side of the mapping (e.g. `"8880:8080"`); the
container side must stay `8080`.

## 3. Start and first login

```bash
docker compose up -d
docker compose logs packratter
```

The first startup creates the admin account; with `ADMIN_PASS` unset, the log contains
the generated password — shown only that once, so note it down (or set `ADMIN_PASS` in
`.env` before starting). Later restarts print nothing; the account already exists.

Check readiness with `curl http://localhost:8080/healthz`, then sign in at `http://localhost:8080/app`, add teammates on the Users page, and set up per-user API keys from the Account page.

## 4. Upgrades

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically at boot; nothing else to do.

`latest` moves with every release. To control rollout timing, pin an exact version
instead (`image: registry.gitlab.com/skeletonek/packratter:0.6.1`) and check the
[release notes](https://gitlab.com/Skeletonek/packratter/-/releases) before upgrading
while the project is pre-1.0.

## 5. Reverse proxy / HTTPS

Session cookies are marked `Secure` in production, so always expose the service through
HTTPS: terminate TLS in your reverse proxy (nginx, Caddy, Traefik, …) and forward to the
container's port. Set `TRUST_PROXY=1` in `.env` so rate limiting keys on the real client
IP instead of the proxy's.

## 6. Related docs

- [Pacman setup](pacman.md) · [Deb setup](deb.md) · [RPM setup](rpm.md) · [Flatpak setup](flatpak.md)
- [API reference](api.md) — scripting with per-user API keys
- [Toolchain requirements](toolchain.md) — what the image bundles and how to disable a format
