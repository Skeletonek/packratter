# Single sign-on (OIDC)

Packratter can accept sign-ins from an OIDC provider — Authentik, Keycloak and
Google all work. SSO is additive: local accounts keep working, and signing in
with SSO produces the same session as a password sign-in. What an account can
do afterwards is governed by repository access grants, not by how it signed in.

## The redirect URI

Register this redirect URI with your provider, using the value of the
`BASE_URL` environment variable:

```
{BASE_URL}/api/v1/auth/sso/callback
```

For example, if Packratter is reachable at `https://packratter.example.com`:

```
https://packratter.example.com/api/v1/auth/sso/callback
```

The URI must match exactly. It is derived from `BASE_URL`, the same variable
that fills the client setup snippets — production deployments should always
set it, because without it the callback is built from the incoming request's
host, which changes with the proxy setup and will not match the registered
value.

## Creating the application

In your provider, create an OIDC client for Packratter:

- **Grant type:** authorization code, with PKCE (`S256` — used automatically,
  no configuration needed on the provider side in most cases).
- **Refresh tokens** are not used; Packratter issues its own session when the
  sign-in completes, so none are needed.
- **Confidential client:** give Packratter the client secret. Packratter also
  supports **public clients** (no secret, PKCE-only authentication) — leave the
  secret empty in Packratter's settings if your provider is set up that way.
- **Scopes:** Packratter requests `openid profile email` by default. If your
  admin claim lives in a group scope (see below), extend the scope list in
  Settings → Authentication, e.g. to `openid profile email groups`.
- **Redirect URI:** exactly the one from the section above.

Provider specifics:

- **Authentik:** create an application with an OAuth2/OIDC provider of type
  "authorization code"; set the redirect URI and copy client ID/secret from the
  provider. The issuer URL is the application's OpenID configuration endpoint
  minus its path, e.g. `https://auth.example.com/application/o/packratter/`.
- **Keycloak:** create a client with "standard flow" enabled, set valid
  redirect URIs, copy client ID/secret. The issuer URL is the realm root,
  e.g. `https://auth.example.com/realms/main`.

## Configuring Packratter

Sign in as an admin and open **Settings → Authentication**. For each field:

| Field               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| Issuer URL          | Discovery root of the provider (see above)                 |
| Client ID           | From the provider application                              |
| Client secret       | From the provider application; empty keeps the one on file |
| Scopes              | Space-separated OIDC scopes to request                     |
| Admin claim + value | Auto-grant the admin role, see below                       |
| Auto-create         | Create accounts on first sign-in, see below                |

Use **Test discovery** before saving — it fetches the provider's
`/.well-known/openid-configuration` and reports the endpoint it found. A typo
in the issuer URL would send every SSO user to a dead end otherwise.

When enabled, the login page shows a **Sign in with SSO** button.

Applications upgraded from versions configured with `SSO_*` environment
variables had those values seeded into the database once; the settings page and
its saved values are now authoritative, and later `.env` changes have no
effect.

## Automatic admin rights

Fill in the admin claim (any field of the provider's userinfo response; dotted
paths like `realm_access.roles` work) and the value to match. An identity whose
claim equals the value — a plain string or an array containing it — is granted
the admin role on sign-in, and loses it again when the claim disappears.

Exception: once an admin edits that account's role on the Users page by hand,
the claim stops managing the account entirely, and the Users page offers a
"hand back to SSO" link to return control to the provider.

If the claim comes from group memberships, make sure the needed scope is
requested (see _Creating the application_).

## How sign-ins become accounts

- The identity's stored subject (`sub`) is matched first, then an existing
  account with the same email is linked.
- Otherwise, a new account is created when auto-create is on: it takes the
  login name from the provider's username claim, has **no local password** and
  **no repository access** — grant access in the repository's Access settings,
  or enable the repository's _Readable by all signed-in users_ option.
- With auto-create off, unknown identities are denied with the message
  `No account exists for this identity` on the login page; an admin creates or
  links the account first (e.g. set the email to match the identity's).

SSO-only accounts cannot use password sign-in and have no password section on
their Account page. An admin can still set one via **Reset** on the Users page,
which allows local login as a fallback.

## Troubleshooting

- **`Discovery failed` in the test** — the issuer URL is wrong or unreachable
  from the Packratter container. The URL must be the discovery root, not the
  `.well-known` path itself.
- **Provider reports a redirect URI mismatch** — `BASE_URL` is unset or does
  not match the registered URI (trailing slashes are tolerated).
- **`No account exists for this identity`** — auto-create is off and no
  existing user matched. See above.
- **`SSO sign-in failed`** — everything else: look for errors in the server
  log. Repeated failures while the provider works are usually a wrong client
  secret.
- **A just-saved provider change does not apply** — it does immediately; use a
  private window to avoid a stale cached state.
