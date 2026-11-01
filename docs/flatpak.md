# Flatpak repositories

## Create a repo

```bash
TOKEN="<bootstrap-token>"

curl -X POST http://localhost:5000/api/v1/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"myflatpak","type":"flatpak"}'
```

## Upload a bundle

```bash
curl -T myapp.flatpak \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  http://localhost:5000/api/v1/repos/<repo-name>/stable/packages
```

## Wait for the rebuild

```bash
curl http://localhost:5000/api/v1/jobs/<job-id>
```

## Configure the client

Fetch the public key and add the remote:

```bash
curl -fsSL http://localhost:5000/api/v1/repos/<repo-name>/stable/gpg-public-key -o key.asc
flatpak remote-add --user --gpg-import=key.asc myrepo http://localhost:5000/r/<repo-name>/stable/flatpak/ostree/
```

Then install an app from the repo:

```bash
flatpak install --user myrepo <app-id>
```
