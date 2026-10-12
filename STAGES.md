# packrat-manager — Staged Roadmap

Date: 2026-10-04
Status: approved for build

Companion document: **`plan.md`** — the design record. All verified corrections have been
folded into it directly (see its §3, §4, §5, §8, §10, §12, §14, §15, §16).

This file is the **build order**: which subset of `plan.md` gets built in which stage, and
what has to be true before moving on. Where the two disagree on *why* something is the
way it is, `plan.md` carries the evidence inline.

---

## 1. Locked decisions

Carried from `plan.md` §1, plus what we settled while staging:

| # | Decision |
|---|---|
| 1 | Host-only. No upstream mirroring / reposync / scheduled sync. |
| 2 | Environments (`testing` -> `stable`) exist, but are **deferred to S4**. S1–S3 use a single implicit `stable` env. |
| 3 | Local disk only. Low volume (MBs / few hundred packages). No S3 in v1. |
| 4 | Flatpak bundles are built elsewhere. Service only imports + hosts. |
| 5 | One DB: SQLite via built-in `node:sqlite`, WAL mode. |
| 6 | TypeScript stack, SvelteKit 2 / Svelte 5. No React. |
| 7 | Single Docker container. |
| 8 | **Base image: Fedora 44 + Node 24.21.0 installed from the official tarball.** (Replaces `plan.md`'s Debian bookworm + Node 26.) |
| 9 | **One GPG homedir per repo**: `/data/keys/gnupg/<repoId>/`, mode `700`. |
| 10 | **GPG keys support both passphrase-protected and unprotected**, defaulting to unprotected. |
| 11 | `/r/*` is publicly readable. Writes require a bearer token. |
| 12 | Metadata generation always shells out to native tools. TS only reads headers for display. |

---

## 2. Base image (verified working)

```dockerfile
FROM registry.fedoraproject.org/fedora:44
ARG NODE_VERSION=24.21.0
RUN dnf -y install createrepo_c dpkg-devel ostree flatpak gnupg2 zstd tar xz \
      bsdtar pacman apt-utils curl findutils \
 && dnf clean all
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
 | tar -xJ -C /usr/local --strip-components=1 --exclude='share/*'
VOLUME /data
EXPOSE 8080
CMD ["node","/app/server.js"]
```

Verified present and working inside that image:

```
repo-add  repo-remove  pacman-key  makepkg  bsdtar  createrepo_c
dpkg-deb  apt-ftparchive  ostree  flatpak  gpg  zstd
node v24.21.0   node:sqlite OK
```

Resolved versions: glibc 2.43, pacman 7.0.0, bsdtar 3.8.7, createrepo_c 1.2.1,
ostree 2026.4, flatpak 1.18.4.

`repo-add --sign --key <fpr>` was run against a real generated key in this image and
produced a verifiable `Good signature`.

Local development uses **podman**, not docker. `podman build` / `podman run` are
drop-in compatible with the above.

### The one non-obvious dependency

`repo-add` is **not an ELF binary** — not on Arch, not on Debian, not on Fedora. It is
a bash script that shells out to `bsdtar`, `gpg`, `gettext`, `sha256sum`, and makepkg's
`compress_as` helper. Package validation is literally:

```bash
if ! bsdtar -tqf "$pkgfile" .PKGINFO >/dev/null; then
    error "'%s' is not a package file, skipping"
```

So `bsdtar` is mandatory. Without it, valid packages are rejected with a misleading
"not a package file" error. This — not Arch tooling — was the real risk in `plan.md` §15.

Package requirements per distro:

| Distro | `repo-add` provider | makepkg helpers | `bsdtar` |
|---|---|---|---|
| Fedora | `pacman` (bundles makepkg + helpers) | included | `bsdtar` (separate pkg) |
| Debian/Ubuntu | `pacman-package-manager` | `makepkg` (separate pkg) | `libarchive-tools` |

---

## 3. Format contract

The single decision that makes the stages composable. Each format is a module, not a
new code path — this is why adding deb/rpm/flatpak does not disturb working pacman code.

```ts
// src/formats/<type>/index.ts
export interface Format {
  validate(filename: string, bytes: Buffer): Result<void, ValidationError>;
  ingest(env: Env, tmpPath: string): Promise<void>;
  rebuild(env: Env, ctx: RebuildContext): Promise<void>;  // shells out + signs
  serveHeaders(path: string): { 'cache-control': string };
  setupSnippet(repo: Repo, env: Env): string;             // pacman.conf / sources.list / repo file
}
```

`RebuildContext` carries the per-repo `GNUPGHOME`, the signing key fingerprint, a temp
dir, and a log sink.

---

## 4. Storage layout (corrected)

```
/data/db.sqlite
/data/keys/gnupg/<repoId>/            # mode 700, one homedir per repo
/data/keys/bin/pinentry-loopback.sh   # mode 700, only used by protected keys
/data/tmp/<jobId>/
/data/repos/<repo>/<env>/
  pacman/                             # packages at ROOT - see plan.md §5
    *.pkg.tar.zst
    <name>.db        -> <name>.db.tar.gz
    <name>.db.sig    -> <name>.db.tar.gz.sig
    <name>.files     -> <name>.files.tar.gz
    <name>.files.sig -> <name>.files.tar.gz.sig
  deb/
    pool/
    dists/stable/main/binary-<arch>/{Packages,Packages.gz,Release,InRelease,Release.gpg}
  rpm/
    packages/
    repodata/
  flatpak/
    ostree/  summary  summary.sig  refs/
```

**Atomic publish rule:** build in `/data/tmp/<jobId>/`, then `rename()` into place.
Readers never see half-written metadata.

**Symlinks must be followed.** `pacman` requests `$repo.db` (i.e. `core.db`). HTTP has
no symlinks, so the static mount has to follow the `.db` symlink and serve the tarball
bytes. `@fastify/static`/`send` does this, but it needs an explicit e2e test or pacman
silently 404s.

---

## 5. Stages

Estimates assume one developer.

### S0 — Foundation (~1 day)

Nothing user-facing. Everything else drops into this shape.

- Single pnpm package (no monorepo), TS strict, eslint + prettier, vitest.
- Fastify 5, env-driven config, structured logs, `/healthz`, uniform error envelope.
- `node:sqlite` + Drizzle (native `node:sqlite` driver, no `better-sqlite3`), embedded
  SQL migrations applied at boot.
- Auth: bootstrap admin from env, one API token printed once at first boot
  (`prefix` + argon2 hash, never logged again).
- **Create the full v1 schema now** — `repos, envs, packages, gpg_keys, repo_keys,
  users, tokens, jobs`, including a default `stable` env per repo — so S4 needs zero
  migrations.
- Dockerfile (podman build verified), CI: typecheck + lint + test.

**Exit:** container starts, `/healthz` responds, migrations apply, bootstrap token issued.

### S1 — Pacman + GPG + minimal UI (~4–6 days) ⭐

The goal stage. `docker run` → push a `.pkg.tar.zst` → it installs on a real Arch box.

- `repos` (type `pacman`), single implicit `stable` env, upload / delete / list.
- Upload via raw body so `curl -T pkg.pkg.tar.zst -H "Authorization: Bearer $TOKEN"`
  works.
- GPG: generate per repo (`--quick-generate-key`) **and** accept armored import.
  Per-repo homedir. Support passphrase-protected keys via `gpg-agent.conf`
  (`allow-loopback-pinentry` + `pinentry-program` script echoing from a mode-600 file),
  so `repo-add --sign` needs no passphrase plumbing of its own.
- Job queue: in-process, concurrency 1 keyed on `(repo, env)`, stdout/stderr into
  `jobs.log`. `LC_ALL=C` is mandatory — otherwise logs come out localized.
- `repo-add <name>.db.tar.gz --sign --key <fpr> <argv built from DB rows, never a
  shell glob>`.
- Serve `/r/:repo/:env/*` with symlink following; `no-cache` on `*.db*` / `*.files*`
  / `*.sig`, `max-age=1y, immutable` on package files.
- `GET .../gpg-public-key` + a copy-pasteable setup snippet.
- Minimal SvelteKit UI: repos list, create repo, upload + job status. Built in
  SvelteKit from day one so nothing is thrown away in S2.
- Tests: unit (filename/arch validation, argv construction, cache headers) plus a
  container e2e that runs a real `pacman` client against the served repo and asserts
  the signature validates.

**Exit:** `pacman -Syu` installs from the repo on a real Arch machine, signature verified.

### S2 — Flatpak import + serve (~2–3 days)

- Behind `ENABLE_FLATPAK=1` (per `plan.md` §15 mitigation).
- `flatpak build-import-bundle` → `flatpak build-update-repo --gpg-sign=<fp>`.
- Serve `ostree/` + `summary` + `summary.sig` with correct MIME types.
- Verify with `flatpak remote-add --gpg-import` in a container.

**Exit:** a bundle imported over the API is installable by a clean `flatpak` client.

### S3 — Deb + RPM (~3–5 days)

Done together — near-identical shape, and doing them as a pair keeps the format
contract honest.

- **Deb:** `apt-ftparchive packages` → `Packages`{`,gz`}; `apt-ftparchive release` →
  `Release`; `gpg --clearsign` → `InRelease`; `gpg -abs` → `Release.gpg`. Single
  `dist=stable comp=main` in v1.
- **RPM:** `createrepo_c --update`, `gpg --detach-sign repomd.xml`.
- No `rpm --addsign` (needs pinentry) unless explicitly requested.
- Per-type setup snippets (`sources.list` / `.repo` file).

**Exit:** `apt-get install` and `dnf install` both work against the service.

### S4 — Envs + promote + jobs UI (~2–3 days)

- Multiple envs per repo, each with independent metadata over a shared blob pool.
- Promote = `link(src, dst)` (hardlink, same volume, cheap) then rebuild the target.
  No symlinked metadata between envs — each env rebuilds independently for isolation.
- UI: env tabs, "in testing not in stable" diff, promote all / selected, job history
  with logs and retry.

**Exit:** promote `testing` -> `stable` produces a byte-identical package set.

### S5 — Hardening (~1–2 days)

- Upload size limits and command timeouts, quotas, rate limiting.
- Backup/restore docs using `sqlite .backup` (not a naive file copy of a WAL db).
- e2e install tests for all four formats in clean client containers.
- Error pages, structured job failure reporting.

### S6 — SSO / OAuth + multi-user (open-ended)

- OIDC (Authentik / Keycloak / Google) as an **additional** login method. Local users
  keep working — this is additive, not a replacement.
- This is where `users.role` earns its keep: per-user repo permissions, scoped tokens,
  service accounts.
- Also the point at which "who may publish to which repo" finally matters.

**Total: ~14–21 days** — lower than `plan.md`'s 4–7 weeks because schema-first plus the
format contract eliminate most of M1's rework.

---

## 6. Open risks

The full risk register is maintained in `plan.md` §15. Only one item is still open, and
it gates exactly one stage:

| Risk | Gates | Mitigation |
|---|---|---|
| `ostree` / `flatpak` in a container + HTTP serving quirks | **S2** | Behind `ENABLE_FLATPAK=1`, with a real `flatpak remote-add --gpg-import` client-verify test as the exit criterion |

Everything else in `plan.md` §15 was resolved during toolchain verification and is marked
as such there.

One proof obligation is carried into S1 rather than assumed: a real `pacman` **client**
installing from the served repo. The db signature has been verified directly with `gpg`,
which is only half of the S1 exit criterion.

