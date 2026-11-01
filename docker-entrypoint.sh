#!/bin/sh
set -e

# Republish DATA_DIR ownership, then drop privileges for the server process.
# Needed when the data directory (or anything inside it) was created by
# another uid — e.g. an earlier root-based version, or a bind mount from the
# host whose uid does not line up through the container's user namespace.
if [ "$(id -u)" = "0" ] && [ "$(id -u packratter)" != "0" ]; then
  chown -R packratter:packratter /data
  exec runuser -u packratter -- node /app/dist/index.js
fi

exec node /app/dist/index.js
