# packrat-manager — Full Plan (TypeScript)

Date: 2026-10-03 (revised 2026-10-04)
Status: reviewed. Sections 3, 4, 5, 8, 10, 12, 14, 15, 16 were corrected on 2026-10-04 after verifying the native toolchain by running it inside a real container — see the inline notes in each section.
Reference: repomanager (https://github.com/lbr38/repomanager) — Deb/RPM mirroring + WebUI. This project is a smaller host-only variant + Pacman + Flatpak, single Docker container.

Build order and stage exit criteria live in **`STAGES.md`** (S0–S6).

## 1. Decisions (locked from discussion)

1. Host-only. No upstream mirroring / reposync / scheduled sync.
2. Environments required (e.g. `testing` -> `stable`). Called "environments". Shipped in S4; S1–S3 use a single implicit `stable` env.
3. Local disk only. Low volume (MBs / few hundred packages). No S3 in v1.
4. Flatpak bundles built elsewhere. Service only imports + hosts.
5. One DB: SQLite only (WAL mode). No Postgres in v1.
6. Stack: TypeScript ecosystem, no React frontend.
7. Deploy: single Docker container. Base is **Fedora 44 + Node 24.21.0 from tarball** (settled 2026-10-04; originally "Node 26 on Debian bookworm").
8. **One GPG homedir per repo** at `/data/keys/gnupg/<repoId>/`, mode `700`.
9. **GPG keys: both passphrase-protected and unprotected are supported; unprotected is the default.**
10. `/r/*` is publicly readable; writes require a bearer token.

## 2. Goals / Non-goals

Goals:
- Create repos of type `deb | rpm | pacman | flatpak`, each with N environments.
- Upload packages via WebUI + CI token (`curl -T`).
- Regenerate + GPG-sign metadata on upload/delete/promote.
- Promote packages between environments (hardlink copy + rebuild target).
- Serve repos over HTTP with correct content-types + caching.
- Manage GPG keys, users, tokens from WebUI.
- Single `docker run -v data:/data -p 8080:8080` deployment.

Non-goals (v1):
- No mirroring upstream Debian/Fedora/Arch/Flathub.
- No `flatpak-builder` / manifest builds in-service.
- No S3, no multi-node, no Postgres/Redis.
- No host fleet management (repomanager has this — out of scope).
- No Delta RPMs, no Flatpak static deltas in v1 (add later if needed).

## 3. Tech stack (concrete)

- Runtime: Node 24 LTS (pin `24.21.0`, codename Krypton, EOL 2028-04-30), installed from the official tarball onto a Fedora 44 base. Node 26 was rejected: it is `lts=false` until 2026-10-28.
- Backend: Fastify 5 + `@fastify/static`, `@fastify/multipart`, `@fastify/cookie`.
- DB: `node:sqlite` (built-in) + Drizzle ORM. Migrations are plain SQL files applied at boot — no `drizzle-kit` at runtime. File: `/data/db.sqlite`.
- Frontend: SvelteKit 2 + Svelte 5 (no React). SSR + forms + server actions. Static output served by Fastify, or single Node process running both (recommended: SvelteKit `adapter-node` behind same Fastify, or build static + `@fastify/static`).
  - Fallback if SPA feels heavy: keep SvelteKit but use only forms + progressive enhancement, no client store complexity.
- Auth: cookie session for UI + `Authorization: Bearer <token>` for API/CI. `argon2` or `bcrypt` for passwords. One `admin` bootstrap via env.
- Jobs: in-process queue, `p-queue` with concurrency=1 per `repo+env` key. No Redis. Job rows in SQLite for visibility (`pending|running|done|error`).
- Validation: `zod`. OpenAPI via `@fastify/swagger` + `utoipa`-style export only if needed for CI docs.
- Tooling: `pnpm`, `typescript strict`, `eslint + prettier`, `vitest`.

Why not NestJS: too much boilerplate for CRUD + shell-out service. Fastify is smaller and matches KISS.

## 4. Architecture (single container)

```
[ browser / CI ] -> :8080 -> Fastify
  |-- /api/*            REST + token auth
  |-- /app/* or /       SvelteKit UI (cookie auth)
  |-- /r/<repo>/<env>/  static repo files (public, immutable-ish caching)
  |-- worker (in-process): serialize rebuilds per env, shell out to native tools
  |-- /data: repos/ + keys/ + db.sqlite + tmp/
```

Native tools installed in same image (Fedora package names):

```
createrepo_c  dpkg  dpkg-devel  apt-utils  gnupg2  ostree  flatpak  zstd  tar  xz
pacman        # provides repo-add, repo-remove, pacman-key, makepkg + /usr/share/makepkg/util/*
bsdtar        # MANDATORY - see below
```

`repo-add` is a bash script on every distro (only `pacman` and `vercmp` are ELF). It
shells out to `bsdtar`, `gpg`, `gettext`, `sha256sum`, `file`, `find`, `sed`, `sort`,
`tr`, and makepkg's `compress_as`. Its package validation is literally
`bsdtar -tqf "$pkgfile" .PKGINFO` — **without `bsdtar` every valid package is rejected
with a misleading "not a package file" error.** There is no Arch-tooling problem here;
`plan.md` previously misdiagnosed this as one.

Per-distro package mapping, for reference: Fedora bundles makepkg's helpers into
`pacman` and ships `bsdtar` separately; Debian/Ubuntu need `makepkg` and
`libarchive-tools` on top of `pacman-package-manager`.

Never reimplement metadata parsers in TS except for reading headers for display (use `dpkg-deb -f`, `rpm -qp`, `tar -tf`). Generation always via native tools.

## 5. Storage layout (`/data`)

```
/data/db.sqlite
/data/keys/gnupg/<repoId>/            # mode 700 - one homedir per repo
/data/keys/bin/pinentry-loopback.sh   # mode 700 - only used by passphrase-protected keys
/data/tmp/<jobId>/
/data/repos/<repo>/<env>/
  deb/{pool/,dists/stable/main/binary-<arch>/{Packages,Packages.gz,Release,InRelease,Release.gpg}}
  rpm/{packages/*.rpm,repodata/}
  pacman/                            # packages at the REPO ROOT - see note below
    *.pkg.tar.zst
    <name>.db        -> <name>.db.tar.gz
    <name>.db.sig    -> <name>.db.tar.gz.sig
    <name>.files     -> <name>.files.tar.gz
    <name>.files.sig -> <name>.files.tar.gz.sig
  flatpak/{ostree/,summary,summary.sig,refs/}
```

Pacman layout notes (verified against pacman 7.0.0):

- Packages sit at the pacman repo root, **not** in a `packages/` subdirectory. `repo-add`
  writes `%FILENAME%` as the bare basename (`format_entry "FILENAME" "${1##*/}"`), and
  pacman resolves it relative to the repo root — a `packages/` prefix would make every
  package download 404.
- Dbs are `.tar.gz`, **not** `.tar.zst`. `.tar.zst` dbs need the experimental
  `--use-new-db-format` flag, which we do not use.
- `.sig` files are symlinks to `<name>.db.tar.gz.sig` / `<name>.files.tar.gz.sig`.
- Both a `.db` and a `.files` db are emitted (pacman 7.x).
- The static mount must **follow symlinks**. `pacman` requests `$repo.db` (i.e.
  `core.db`), and HTTP has no symlink concept, so `<name>.db` must serve the tarball
  bytes. `@fastify/static`/`send` does resolve symlinks, but this needs an explicit e2e
  assertion or the symptom is a silent 404 that looks like a signing failure.

Atomic publish rule: build in `tmp/`, then `rename()` into place. Readers never see half-written `repodata` / `dists` / `summary`.

Config via env: `DATA_DIR=/data PORT=8080 BASE_URL=https://repos.example.com ADMIN_USER ADMIN_PASS`. GPG root is `GPG_ROOT=/data/keys/gnupg`; each repo gets a subdirectory of it.

All native tool invocations run with `LC_ALL=C`, otherwise job logs come out localized and are unparseable.

## 6. DB schema (SQLite)

```sql
repos(id TEXT PK, name TEXT UNIQUE, type TEXT, created_at INT);
envs(id TEXT PK, repo_id FK, name TEXT, UNIQUE(repo_id,name));
packages(id TEXT PK, env_id FK, filename TEXT, version TEXT, arch TEXT,
  size INT, sha256 TEXT, status TEXT, created_at INT);
gpg_keys(id TEXT PK, fingerprint TEXT UNIQUE, public_armored TEXT, created_at INT);
repo_keys(repo_id FK, key_id FK); -- which key signs which repo
users(id TEXT PK, login UNIQUE, pass_hash TEXT, role TEXT);
tokens(id TEXT PK, user_id FK, prefix TEXT, hash TEXT, scopes TEXT, created_at INT);
jobs(id TEXT PK, repo_id FK, env_id FK, kind TEXT, status TEXT, log TEXT, created_at INT);
```

Indexes on `(env_id, filename)`, `(repo_id)`, `jobs(status, created_at)`.

## 7. API (v1, minimal)

```
POST /api/v1/repos {name, type}
POST /api/v1/repos/:repo/envs {name}
PUT  /api/v1/repos/:repo/:env/packages  (multipart or raw .deb/.rpm/.pkg.tar.zst/.flatpak, Bearer token)
  -> creates package row status=pending, enqueues rebuild job, returns jobId
DELETE /api/v1/repos/:repo/:env/packages/:filename -> enqueue rebuild
POST /api/v1/repos/:repo/promote {from, to, filenames?|all} -> hardlink copy + rebuild `to`
GET  /api/v1/repos/:repo/:env/packages?q=&page=
GET  /api/v1/jobs/:id
GET  /api/v1/repos/:repo/:env/gpg-public-key
```

Client examples must work with `curl -T package.deb -H "Authorization: Bearer $TOKEN"`.

Serve:
```
GET /r/:repo/:env/...  (public)
```
Set `Cache-Control: no-cache` for metadata (`Release`, `repomd.xml`, `*.db*`, `summary`), `max-age=1y, immutable` for `pool/*.deb`, `packages/*`.

## 8. Per-format rebuild (worker)

Serialize per `(repo,env)` with file lock + `jobs` row. Capture stdout/stderr to job log.

- Deb: move uploads to `pool/`, run `apt-ftparchive packages pool/ > dists/.../Packages`,
  gzip, then `apt-ftparchive release dists/<dist>/ > Release`,
  `gpg --clearsign -o InRelease Release`, `gpg -abs -o Release.gpg Release`.
  Structure v1: single `dist=stable comp=main` to stay simple. Multi-dist later.
  Note: `dpkg-scanpackages` is **not available on Fedora** (`dpkg` does not ship it and
  `dpkg-devel` ships no binaries at all), so `apt-ftparchive` from `apt-utils` is the
  generator. It also produces `Release`, which `dpkg-scanpackages` cannot.
- RPM: move to `packages/`, run `createrepo_c --update --general-compress-type=zstd .`. Sign `repomd.xml` with `gpg --detach-sign` if key assigned. Optional `rpm --addsign` on upload (requires `rpm-sign` + expect pinentry — defer unless requested).
- Pacman: move to the pacman repo root (not a `packages/` subdir — see §5), run
  `repo-add <name>.db.tar.gz --sign --key <fpr> <argv built from DB rows>`.
  Never pass a shell glob; build argv from the `packages` table so filenames with
  spaces or shell metacharacters cannot break out. Emits `.db` and `.files`, each with
  a `.sig` symlink, all `.tar.gz`.
- Flatpak (import-only): `flatpak build-import-bundle --ostree-repo=ostree bundle.flatpak` or `ostree static-delta` path, then `flatpak build-update-repo --gpg-sign=<fp> --generate-static-deltas ostree/`. Serve `ostree/` + `summary` + `summary.sig` over HTTP with correct MIME. Test with `flatpak remote-add --gpg-import=key`.

All commands with timeouts + size limits (e.g. 2GB/file default, configurable).

## 9. Environments / promote

- Env = independent metadata + shared blob pool. Implementation: per-env dirs, promote = `link(src,dst)` (hardlink, same volume so cheap) then rebuild dst.
- No symlinked metadata between envs. Each env rebuilds independently for isolation.
- UI: env tabs, `Promote all / selected -> stable` button, job progress, diff view (`in testing not in stable`).

## 10. GPG

- One key per repo (v1). Generate via `gpg --quick-generate-key` or import existing.
  Each repo gets its **own homedir** at `/data/keys/gnupg/<repoId>/`, mode `700`. This
  isolates keys, makes public-key export a single-homedir enumeration, and makes repo
  deletion a directory removal. `repo-add --key <fpr>` enforces which key signs what.
- **Both protected and unprotected keys are supported; unprotected is the default.**
  Generated keys use `--batch --passphrase ''`, so security comes from filesystem
  permissions on the homedir rather than a passphrase.
- For passphrase-protected keys, never log the passphrase and never try to plumb
  `--pinentry-mode loopback` through `repo-add` — it shells out to `gpg` and cannot
  accept extra flags. Instead write into the homedir's `gpg-agent.conf`:
  ```
  allow-loopback-pinentry
  pinentry-program /data/keys/bin/pinentry-loopback.sh
  ```
  where the script (mode 700) echoes the passphrase from a mode-600 file. Both `repo-add
  --sign` and `gpg -abs` then work unchanged, and gpg-agent's cache means the passphrase
  is paid once per agent rather than per signature.
- Publish `public.asc` per repo for `curl ... | apt-key` / `rpm --import` / `pacman-key` / `flatpak remote-add --gpg-import` instructions page.

## 11. Frontend (SvelteKit, no React)

Pages:
- `/` repos list + create.
- `/repos/:repo` env tabs, package search, upload dropzone, job status.
- `/repos/:repo/promote` diff + promote action.
- `/repos/:repo/setup` copy-paste client snippets per type (apt/dnf/pacman/flatpak).
- `/keys`, `/users`, `/tokens`, `/jobs`.

Forms over client state. No redux/store. File upload with progress + polling `GET /api/v1/jobs/:id`.

## 12. Docker

Single image. Base is **Fedora 44**, not Debian: bookworm's glibc is 2.36 (2023), which
is too old to build an internet-facing service on, whereas Fedora 44 ships glibc 2.43.
Node is installed from the official tarball so it stays pinned independently of the
distro. (There is no `node:26-noble` tag — official Node v26 images ship bookworm
variants only — so an Ubuntu base gains nothing.)

Note `bsdtar` is required for `repo-add` to function at all; see §4.

```dockerfile
FROM registry.fedoraproject.org/fedora:44
ARG NODE_VERSION=24.21.0
RUN dnf -y install createrepo_c dpkg-devel ostree flatpak gnupg2 zstd tar xz \
      bsdtar pacman apt-utils curl findutils \
 && dnf clean all
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
 | tar -xJ -C /usr/local --strip-components=1 --exclude='share/*'
COPY dist/ /app/
VOLUME /data
EXPOSE 8080
CMD ["node","/app/server.js"]
```

Verified in this image: `repo-add`, `repo-remove`, `pacman-key`, `makepkg`, `bsdtar`,
`createrepo_c`, `dpkg-deb`, `apt-ftparchive`, `ostree`, `flatpak`, `gpg`, `zstd`,
`node v24.21.0` with `node:sqlite`. `repo-add --sign --key <fpr>` was run against a real
generated key and produced a `Good signature`.

`docker-compose.yml`: one service + `volumes: [./data:/data]` + env file. Backup = stop + copy `/data`.

Alpine was considered and rejected: it does ship `repo-add` (in `pacman-7.0.0-r0`) plus
`ostree` and `flatpak`, but has **no `createrepo_c`**, which kills the RPM stage.

## 13. Testing

- `vitest` unit: promote logic, filename parsing, auth, API validation.
- Integration (container): upload -> rebuild -> install in clean containers (`debian:stable` + `apt-get`, `fedora` + `dnf`, `archlinux` + `pacman -U`, `flatpak install --user`).
- Fixtures: tiny dummy `.deb/.rpm/.pkg.tar.zst/.flatpak` built in CI.
- Acceptance: GPG verify (`apt-secure`, `repomd.xml.asc`, `pacman-key`, `flatpak` summary sig).

## 14. Milestones

Build order and exit criteria are maintained in **`STAGES.md`** (S0–S6), which supersedes
the original M1–M6 estimate below. Summary:

| Stage | Scope | ~Time |
|---|---|---|
| S0 | Foundation: Fastify 5, `node:sqlite`+Drizzle, auth/tokens, full v1 schema created up front, Dockerfile, CI | 1d |
| S1 | **Pacman upload / rebuild / serve + GPG sign + minimal UI** — exit: `pacman -Syu` on a real Arch box, signature verified | 4–6d |
| S2 | Flatpak import + serve, behind `ENABLE_FLATPAK=1` | 2–3d |
| S3 | Deb + RPM upload / rebuild / serve + GPG sign + setup snippets | 3–5d |
| S4 | Multi-env + promote + diff view + job history | 2–3d |
| S5 | Hardening: quotas, limits, backup docs, e2e install tests | 1–2d |
| S6 | SSO/OIDC + per-user repo permissions + scoped tokens | open |

Total ~14–21 days, one developer. Environments are deliberately **deferred to S4** even
though they were originally M4 — S1–S3 ship with a single implicit `stable` env, and the
`envs` table plus its default row are created in S0 so no migration is ever needed.

Original M1–M6 estimate (superseded, kept for reference):

1. M1 (1wk): Fastify + SQLite + auth/tokens + `/r/` static + Docker skeleton + SvelteKit shell.
2. M2 (1wk): Pacman upload/rebuild/serve + GPG sign + setup snippet.
3. M3 (2-3wk): Flatpak import + serve + client verify (import-only, bundles built elsewhere).
4. M4 (1wk): Envs + promote + jobs UI + delete (prove on Pacman/Flatpak first).
5. M5 (1-2wk later): Deb + RPM upload/rebuild/serve + GPG sign + setup snippets.
6. M6 (1wk): Hardening (quotas, limits, backups docs, e2e install tests).

Estimate: 4-7 weeks, 1 dev, TS stack.

## 15. Risks

- ~~`ostree/flatpak` in Docker + HTTP serving quirks~~ — mitigate by doing Flatpak behind `ENABLE_FLATPAK=1` in S2, with a real `flatpak remote-add` client-verify test. **Still open.**
- ~~`repo-add` on Debian base needs Arch tools~~ — **RESOLVED, and the original diagnosis was wrong.** `repo-add` is a bash script on every distro including Arch; only `pacman`/`vercmp` are ELF. It needs `bsdtar` + makepkg's `compress_as`, both of which Fedora's `pacman` package provides or pairs with. Verified by running it.
- ~~GPG pinentry in headless container~~ — **RESOLVED.** Per-repo `gpg-agent.conf` with `allow-loopback-pinentry` + a `pinentry-program` script. No passphrase plumbing needed through `repo-add`.
- ~~`dpkg-scanpackages` availability~~ — **RESOLVED.** Absent on Fedora entirely; `apt-ftparchive` replaces it and also generates `Release`.
- Large Packages/repodata rebuild time — fine at low volume; `--update` for RPM, full regen for others.
- New: `repo-add` writes `%FILENAME%` as a bare basename, so pacman packages must live at the repo root or every download 404s. See §5.

## 16. Open questions for build start

- Single `stable/main` suite for Deb v1 — ok? (assumed yes)
- ~~One GPG key per repo~~ — settled: one key per repo, one homedir per repo (§10).
- ~~Public read for `/r/*` or token-gated?~~ — settled: public read, token required for writes.
- SSO/OAuth (S6): which OIDC providers to support first?
- Still to prove in S1: a real `pacman` **client** installing from the served repo. The db signature has been verified directly with `gpg`, which is only half of the exit criterion.
