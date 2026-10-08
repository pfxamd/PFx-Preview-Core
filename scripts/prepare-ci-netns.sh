#!/usr/bin/env bash
set -euo pipefail
# GitHub-hosted Ubuntu runners differ in their AppArmor user-namespace policy.
# This script runs ONLY on disposable GitHub CI runners, not on production hosts.
# Never run browser tests without a working network namespace.
if unshare --user --map-root-user --net --fork -- true >/dev/null 2>&1; then
  echo 'User/network namespaces already available.'
  exit 0
fi
printf '%s\n' 'Initial user/network namespace probe failed. Checking CI host policy.'
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
if [[ -f /proc/sys/kernel/unprivileged_userns_clone ]]; then
  sudo sysctl -w kernel.unprivileged_userns_clone=1
fi
if ! unshare --user --map-root-user --net --fork -- true; then
  echo 'ERROR: Isolated Chromium cannot be tested on this CI runner.' >&2
  exit 1
fi
printf '%s\n' 'Verified: unprivileged user and network namespaces work.'
