# Signing key lifecycle

Every repository gets its own GPG keypair; the private key signs the repository
metadata so clients can verify package authenticity. The keys live under
`keys/gnupg/<repoId>/` in `DATA_DIR`, one homedir per repository.

## Protecting keys with a passphrase

Keys are generated without a passphrase by default — convenient for a team tool
where the service must sign unattended. **For repositories exposed to the
internet, use a passphrase-protected key.** Whoever exfiltrates the keyring
otherwise can publish packages your clients will trust.

A protected key needs a passphrase file the service reads at signing time:

```bash
chmod 600 /data/keys/passphrases/<repoId>
```

Keep the passphrase file outside the backup tarball if you can, or encrypt the
whole `keys/` tree (see `backup.md`). Rotate immediately if a passphrase file or
keyring leaks.

## Rotating a key

1. Generate or import a new key for the repository (repository settings →
   keys). Both keys may coexist during the transition.
2. Rebuild each environment so the metadata (`*.db`, `Release`/`InRelease`,
   `repomd.xml`, `summary`) is re-signed with the new key.
3. Publish the new public key to clients. The old key must stay in client
   trust stores until every client has switched — otherwise signature
   verification of existing metadata fails.
4. Remove the old key from the repository once the transition window closes,
   rebuild again, and revoke the old key if your process requires it.

Plan a transition window matching your slowest client; a package manager with a
stale key cache will refuse to update until it receives the new key.

## Backups

`keys/` contains private material. Back it up **encrypted** and restrict who
can read the backup — anyone holding the keys can publish packages as you. See
`backup.md` for the mechanics and `production.md` for the deployment checklist
item covering this.
