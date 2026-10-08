#!/bin/sh
set -eu
# Isolate network, mount tree, processes, IPC and hostname. Fail closed.
exec unshare --user --map-root-user --net --mount --pid --ipc --uts --fork \
  --propagation private -- /bin/sh "$PFX_SANDBOX_BOOTSTRAP" "$@"
