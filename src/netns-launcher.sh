#!/bin/sh
set -eu
# Fail closed: if user+network namespaces cannot be created, browser never runs.
exec unshare --user --map-root-user --net --fork -- "${PFX_NODE_BINARY:-/usr/bin/node}" "$PFX_NETNS_WORKER" "$@"
