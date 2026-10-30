# Deb repositories

## Create a repo

```bash
TOKEN="<bootstrap-token>"

curl -X POST http://localhost:5000/api/v1/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","type":"deb"}'
```

## Upload a package

```bash
curl -T mypackage.deb \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  http://localhost:5000/api/v1/repos/<repo-name>/stable/packages
```

Packages are grouped by architecture (`pool/<arch>/`). `Architecture: all`
packages are included in every architecture's index.

## Wait for the rebuild

```bash
curl http://localhost:5000/api/v1/jobs/<job-id>
```

## Configure the client

Fetch the setup snippet and run it on the client:

```bash
curl http://localhost:5000/api/v1/repos/<repo-name>/stable/setup-snippet
```

It adds a signed-by keyring and a `sources.list` entry, then runs `apt-get update`.
Install from the repo with:

```bash
sudo apt-get install <package>
```
