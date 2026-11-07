# Production deployment checklist

A validated runbook for running Packratter as production infrastructure. The
compose-first install itself is covered in `install.md`; this document covers
what has to be true once real users and real clients depend on the service.

## TLS termination

Packratter serves plain HTTP. Terminate TLS in front of it (Caddy, nginx,
Traefik, or your platform's ingress) and set:

```yaml
environment:
  TRUST_PROXY: '1'
```

`TRUST_PROXY=1` makes rate limiting and request logging see the real client IP
from `X-Forwarded-For` instead of the proxy's. Without it, a single shared
limit applies to every user behind the proxy.

Also set `BASE_URL` to the public https URL — setup snippets and OIDC redirects
use it. Session cookies are marked `Secure` when `NODE_ENV=production`, so a
TLS-less deployment signs users out constantly; don't run without TLS.

## File permissions

The container runs as a non-root user. On the host:

```bash
mkdir -p data && chown -R 1000:1000 data
```

`DATA_DIR` must be writable by that uid (db, `tmp/`, `repos/`, `keys/`). The
GPG homedirs under `keys/gnupg/<repoId>/` are mode `700` by design — do not
relax them. Restrictive host permissions matter: the database holds password
hashes, session hashes and TOTP secrets; `keys/` holds the repository signing
keys.

## Backups

Schedule the procedure in `backup.md` — database snapshot via `sqlite .backup`
plus a tarball of `repos/` and `keys/`. Two rules that bite in production:

- **Encrypt the `keys/` portion** and restrict who can read the backup
  (`signing-keys.md`). Anyone holding the keys can publish packages as you.
- **Test the restore**, not just the backup. A backup that has never been
  restored is a hypothesis.

Retention of jobs and audit entries is automatic (`JOB_RETENTION_DAYS=30`,
`AUDIT_RETENTION_DAYS=365`, `0` keeps audit forever). This bounds database
growth; it does not shrink an already-large file — see the note in `backup.md`
if that ever matters.

## Secrets and accounts

- Set `ADMIN_PASS` on first boot (or capture the generated one-time password
  from stdout before anyone else does). Rotate it after bootstrap.
- `ADMIN_USER` names the bootstrap admin only; day-to-day admin access comes
  from per-user accounts with `role: admin`.
- Prefer SSO with an admin claim over long-lived admin passwords where
  possible; local accounts are the fallback, so give them second factors
  (`two-factor.md`).
- API keys appear exactly once at creation. Expire them (`expiresInDays`) and
  watch the "last used" column on the Account page; revoke what rots.

## Health and shutdown

`GET /healthz` is public and suitable for load-balancer checks. The process
handles `SIGTERM`/`SIGINT` by closing the HTTP server — give it a few seconds
of termination grace in the container runtime.

## After upgrading

- Migrations apply automatically at boot; the schema is forward-only.
- Read `CHANGELOG.md` for behavior changes (session rules, audit events,
  deprecations) before rolling out to users.
