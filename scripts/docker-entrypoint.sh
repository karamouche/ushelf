#!/bin/sh
# Platforms such as Fly.io start the container as root with a root-owned volume on /data.
# Take ownership of the data root once, then run uShelf as the unprivileged node user.
set -eu

if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %U /data)" != "node" ]; then
    chown node:node /data
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
