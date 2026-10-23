# Pacman repositories

## Create a repo

```bash
TOKEN="<bootstrap-token>"

curl -X POST http://localhost:5000/api/v1/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","type":"pacman"}'
```

## Upload a package

The filename is read from `.PKGINFO`, so the uploaded file can have any name.

```bash
curl -T mypackage.pkg.tar.zst \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  http://localhost:5000/api/v1/repos/<repo-id>/stable/packages
```

## Wait for the rebuild

```bash
curl http://localhost:5000/api/v1/jobs/<job-id>
```

## Configure the client

Fetch the setup snippet and add it to `/etc/pacman.conf`:

```bash
curl http://localhost:5000/api/v1/repos/<repo-id>/stable/setup-snippet
```

Then run `pacman -Sy` and install from the repo.
