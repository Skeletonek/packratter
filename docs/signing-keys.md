# Signing key lifecycle

Every repository has a GPG keypair; the private key signs the repository
metadata so clients can verify package authenticity. The keys live under
`keys/gnupg/<repoId>/` in `DATA_DIR`, one homedir per repository.

## Using your own key

You can bring your own GPG key instead of the generated one — either when
creating a repository ("Sign with your own key") or later from
**Settings → Keys → Replace**. Passphrase-protected keys are supported; the
passphrase is stored in `keys/passphrases/<repoId>` (mode 600) and read at
signing time. Keys are validated on import — a wrong passphrase or a
public-only block is rejected immediately.

Replacing a key is **rotation**: metadata is re-signed with the new key, so
clients pinned to the old key must install the new one. The old public key
stays downloadable by fingerprint during the transition:

```
/r/<repo>/<env>/gpg-public-key                   # current key
/r/<repo>/<env>/gpg-public-key/<fingerprint>     # any key ever used
```

A client that installs both public keys accepts old and new metadata.

> **Known limitation:** metadata is signed by one key at a time. Dual-signing
> a single artifact (`core.db.sig`, `InRelease`, …) so that either key alone
> verifies _new_ metadata is not supported — the four toolchains have no
> common mechanism for it. Rotation therefore has a switchover window; plan it
> as described below.

## Protecting keys with a passphrase

Generated keys have no passphrase — convenient for a team tool where the
service must sign unattended. **For repositories exposed to the internet, use
a passphrase-protected key** (import one via "Sign with your own key" or
Replace). Whoever exfiltrates the keyring otherwise can publish packages your
clients will trust.

On import, the passphrase is stored in `keys/passphrases/<repoId>` (mode 600)
and read at signing time. Keep that file outside the backup tarball if you
can, or encrypt the whole `keys/` tree (see `backup.md`). Rotate immediately
if a passphrase file or keyring leaks.

## Rotating a key

**Settings → Keys → Replace** does the whole rotation in one step: the new
key is imported and validated, and each environment is rebuilt so the metadata
(`*.db`, `Release`/`InRelease`, `repomd.xml`, `summary`) is re-signed.

What remains is client communication:

1. Publish the new public key to clients (`/r/<repo>/<env>/gpg-public-key`,
   or the fingerprint URL for the old one). Clients that install both keys
   accept old and new metadata through the switch.
2. Expect clients pinned to the old key to reject updates until they install
   the new one — plan the switchover around your slowest client.
3. The old key stays downloadable by fingerprint indefinitely; remove it from
   client trust stores once the transition closes, and revoke the old key if
   your process requires it.

## Backups

`keys/` contains private material. Back it up **encrypted** and restrict who
can read the backup — anyone holding the keys can publish packages as you. See
`backup.md` for the mechanics and `production.md` for the deployment checklist
item covering this.
