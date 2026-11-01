# Backup and restore

Packratter keeps everything in `DATA_DIR`: the SQLite database (`db.sqlite` plus its
`-wal`/`-shm` sidecars), the GPG keyrings under `keys/gnupg/`, and the served
repositories under `repos/`. A restore needs all three.

## Why not copy the files directly

The database runs in WAL mode: a straight file copy taken while the service is
running can capture a torn combination of `db.sqlite` and `db.sqlite-wal` and be
unusable. Use SQLite's own backup mechanism instead, which produces a
self-consistent snapshot — the server keeps serving while it runs.

## Snapshot the database

Inside the container (or on the host, while the service is running):

```bash
node --input-type=module -e '
  const { DatabaseSync, backup } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.DATA_DIR + "/db.sqlite");
  await backup(db, process.env.DATA_DIR + "/tmp/db.snapshot.sqlite");
'
```

`node:sqlite` is built in — no extra tooling needed. Copy the resulting
`db.snapshot.sqlite` off the machine (append a date), then remove it from `tmp/`.

## Archive the payload

Packages, repository metadata and GPG keys are plain directories — safe to tar
while the service is idle; if a rebuild job is running, wait for it (or rely on the
next snapshot for the database):

```bash
tar -C data -czf backup-$(date -I).tar.gz repos keys
```

`keys/` contains the private GPG keys that sign your repositories. Keep that part
of the backup encrypted and restricted access to it — whoever holds the keys can
publish trusted packages to every client configured for this service.

## Schedule

A systemd timer or cron entry that runs both commands nightly and keeps ~14 daily
and a few weekly copies is plenty for the expected repo sizes. Test the restore at
least once after setting it up.

## Restore

1. Stop the service (`docker compose down`, `systemctl stop packratter`, …).
2. Replace `DATA_DIR/db.sqlite*` files with the snapshot, and unpack the archive
   over `repos/` and `keys/`.
3. Fix ownership if the service runs as a non-root user (the container uses
   uid/gid 1000) and start the service again.
4. The first boot re-runs idempotent migrations — no action required.
