# Toolchain requirements

Packratter never reimplements metadata logic — it shells out to native tools for
validation and metadata generation. Each supported ecosystem needs its tools
available on the server host. A missing tool only affects repos of that type: the
upload fails validation or the rebuild job fails, and the job log shows the error.

If you use the provided Docker image (Fedora 44 base — see `Dockerfile`),
everything below is already installed and nothing else is needed.

Packratter checks these tools live on every repo creation and upload, and scans the
set once at startup (the missing ones are logged as warnings). A type with missing
tools is disabled: creating or uploading to such a repo answers `409
TOOLCHAIN_MISSING` with the exact tool names, and the web UI shows which ecosystems
are unavailable and why. Installing a missing tool is picked up on the next request —
no restart needed.

An ecosystem can be turned off even when its tools exist, via `DISABLE_PACMAN=1`,
`DISABLE_DEB=1`, `DISABLE_RPM=1` or `DISABLE_FLATPAK=1` (see `.env.example`). Such a
type answers `409 TYPE_DISABLED` and is intentionally silent in the UI.

## Tools per ecosystem

| Ecosystem | Tools                        | Used for                                                                                                               |
| --------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| pacman    | `repo-add`, `bsdtar`         | package validation (`bsdtar` reads `.PKGINFO`), repo database and `.files` index, per-repo GPG key is used for signing |
| deb       | `dpkg-deb`, `apt-ftparchive` | package validation and control fields, `Packages` / `Release` metadata                                                 |
| rpm       | `rpm`, `createrepo_c`        | package validation (`rpm -qp`), repodata generation                                                                    |
| flatpak   | `flatpak`, `ostree`          | bundle import into an OSTree repo, summary regeneration, commit/summary signing                                        |

Independently of the ecosystem:

- **Node.js 22+** is required to run Packratter itself.
- **`gnupg2`** is required for every repo: a GPG key is generated per repo at
  creation time and used for all metadata signing.

Note that `repo-add` is not a binary but a bash script that shells out to
`bsdtar`, `gpg`, `gettext` and `sha256sum` — these come with the `pacman`
packaging (`pacman-package-manager` + `makepkg` on Debian/Ubuntu).

## Fedora

```bash
sudo dnf install pacman bsdtar dpkg-devel apt-utils createrepo_c flatpak ostree gnupg2
```

Base utilities also used by the packaged tools: `zstd tar xz curl findutils`.

## Debian / Ubuntu

```bash
sudo apt install pacman-package-manager makepkg libarchive-tools dpkg apt-utils createrepo-c flatpak ostree gnupg2
```

## Arch

Arch is naturally covered for pacman (`pacman`, `libarchive` provide the above).
For the other ecosystems install the distro packages as available, or use the
Docker image.
