#!/bin/sh
set -eu

# Invoked only inside a NEW user, mount, PID, IPC, UTS and network namespace.
# Nothing with untrusted website content runs before this fail-closed setup.
: "${PFX_SANDBOX_ROOT:?Missing sandbox root}"
: "${PFX_NETNS_WORKER:?Missing relay}"
: "${PFX_REAL_CHROMIUM:?Missing browser}"
: "${PFX_HOST_PROXY_SOCKET:?Missing guarded proxy bridge}"

root=$PFX_SANDBOX_ROOT
case "$root" in /tmp/pfx-fs-*) ;; *) echo 'Refusing unsafe sandbox path' >&2; exit 1 ;; esac
[ -d "$root" ] && [ ! -L "$root" ] || exit 1

# Mounting a private tmpfs removes the host directory contents from the child.
mount -t tmpfs -o mode=0700,size=64m,nosuid,nodev tmpfs "$root"
mkdir -p "$root/usr" "$root/browser" "$root/node-bin" "$root/app" "$root/bridge" \
  "$root/proc" "$root/tmp" "$root/dev/shm" "$root/etc/ssl/certs" "$root/etc/fonts" "$root/run"
chmod 0700 "$root/tmp"

bind_ro() {
  src=$1
  target=$2
  mount --bind "$src" "$target"
  mount -o remount,bind,ro,nosuid,nodev "$target"
}

# Nothing under the host HOME, repository, cloud credentials or data directories
# is mounted. The browser bundle and relay file are read-only.
bind_ro /usr "$root/usr"
bind_ro "$(dirname "$PFX_NODE_BINARY")" "$root/node-bin"
bind_ro "$(dirname "$PFX_REAL_CHROMIUM")" "$root/browser"
: > "$root/app/relay.js"
bind_ro "$PFX_NETNS_WORKER" "$root/app/relay.js"
bind_ro "$(dirname "$PFX_HOST_PROXY_SOCKET")" "$root/bridge"

# Standard library layout on merged-/usr Linux systems.
for name in bin sbin lib lib64; do
  if [ -e "/$name" ]; then
    target=$(readlink -f "/$name")
    case "$target" in /usr/*) ln -s "${target#/}" "$root/$name" ;; *)
      mkdir -p "$root/$name"
      bind_ro "/$name" "$root/$name"
    ;; esac
  fi
done

for path in /etc/ssl/certs /etc/fonts; do
  if [ -d "$path" ]; then bind_ro "$path" "$root$path"; fi
done
printf 'root:x:0:0:isolated:/tmp:/bin/sh\n' > "$root/etc/passwd"
printf 'root:x:0:\n' > "$root/etc/group"
for device in null zero random urandom; do
  : > "$root/dev/$device"
  mount --bind "/dev/$device" "$root/dev/$device"
done
mount -t tmpfs -o mode=1777,size=128m,nosuid,nodev tmpfs "$root/dev/shm"
mount -t tmpfs -o mode=1777,size=128m,nosuid,nodev tmpfs "$root/tmp"

# A fresh procfs in the new PID namespace; if the host forbids it, stop.
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
/usr/sbin/ip link set lo up

# Never carry host paths into the jailed worker; these are names inside chroot.
export PFX_HOST_PROXY_SOCKET="/bridge/$(basename "$PFX_HOST_PROXY_SOCKET")"
export PFX_REAL_CHROMIUM="/browser/$(basename "$PFX_REAL_CHROMIUM")"
export HOME=/tmp TMPDIR=/tmp XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache
unset PFX_SANDBOX_ROOT PFX_NETNS_WORKER PFX_SANDBOX_BOOTSTRAP

# exec makes the relay PID 1 of the child PID namespace, rooted in the jail.
printf '{"type":"module"}\n' > "$root/app/package.json"
exec chroot "$root" "/node-bin/$(basename "$PFX_NODE_BINARY")" /app/relay.js "$@"
