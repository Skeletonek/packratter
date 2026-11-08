# Two-factor authentication

Packratter supports TOTP (authenticator apps) and WebAuthn (hardware security
keys) as second factors for **local accounts**. SSO sign-ins use the identity
provider's own second factor instead — enabling MFA there is the provider's
job, and Packratter never sees the SSO credentials.

## How it works

Sign-in becomes two steps: after the password is accepted the login form asks
for the second factor. A factor can be either the authenticator code or a
security key; recovery codes work in the code field as a fallback.

**SSO sign-ins use the identity provider's own second factor instead** —
enabling MFA there is the provider's job, and Packratter never sees the SSO
credentials. This applies even to hybrid accounts (a local password plus an
SSO link): the IdP is the second-factor authority for its sign-in path. If a
second factor is required for every sign-in regardless of method, enforce it
at the IdP.

Enrollment happens on the **Account** page:

- **TOTP** — scan the QR code (rendered locally in your browser; the secret
  never leaves the page) or enter the key manually, confirm with a code, then
  store the 10 recovery codes shown once — download them as a text file. TOTP
  turns on only after you confirm the codes are saved.
- **Security keys** — register one or more keys and label them. Register a
  backup key so losing one is not an outage. Removing a key (including the
  last one) requires your password; sign-in then falls back to the password,
  or to SSO for accounts without one.

## Recovery story

- **Recovery codes** are shown exactly once at TOTP enrollment and can be
  regenerated from the Account page. Each works once.
- **An admin password reset** is an account takeover: it clears all second
  factors along with the password and signs every session out. Use it when a
  user loses their authenticator and recovery codes. There is deliberately no
  softer override — proof of the account comes from an admin or the factor
  itself.
- Disabling TOTP on the Account page requires the TOTP code, a recovery code,
  or the account password.

## Where WebAuthn works

Security keys need a **secure context**: HTTPS in production, or a browser
treated local address (`localhost`, `127.0.0.1`) in development. The ceremony
binds to the hostname the browser uses, so register and use keys under one
consistent address — a key registered via `127.0.0.1` will not match a later
visit via `localhost`. When adding a key fails, the error is shown instead of
failing silently.

## Why TOTP secrets are stored as-is

The TOTP secret is stored in the database next to the password hash because the
service must verify codes server-side — it is a shared symmetric secret, not a
password. Protect it like any part of `DATA_DIR` (see `production.md`): a
readable database already means total compromise.
