# RPM repositories

## Create a repo

```bash
TOKEN="<bootstrap-token>"

curl -X POST http://localhost:5000/api/v1/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"myrepo","type":"rpm"}'
```

## Upload a package

```bash
curl -T mypackage.rpm \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  http://localhost:5000/api/v1/repos/<repo-name>/stable/packages
```

## Wait for the rebuild

```bash
curl http://localhost:5000/api/v1/jobs/<job-id>
```

## Configure the client

Fetch the setup snippet and run it on the client:

```bash
curl http://localhost:5000/api/v1/repos/<repo-name>/stable/setup-snippet
```

It writes a `.repo` file with `repo_gpgcheck=1` (the repodata is GPG-signed;
package signatures are not checked). Install from the repo with:

```bash
sudo dnf install <package>
```
