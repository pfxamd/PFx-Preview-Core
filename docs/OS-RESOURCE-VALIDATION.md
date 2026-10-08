# OS resource validation — deployment gate

## Status

The core can **verify** existing Linux cgroup v2 limits. It cannot create a cgroup,
assign per-tenant cgroups, or prove that the host is safe for public traffic.
Application session/pixel quotas are not kernel limits.

Before enabling any remotely accessible deployment, an operator must put the
**entire PFx Preview Core service including Chromium workers** in a dedicated
kernel-enforced cgroup v2. Restrict the entire service to reasonable values:

| cgroup v2 control | Example value | Current verifier's permitted range |
| --- | --- | --- |
| `memory.max` | `4294967296` (4 GiB) | 256 MiB–8 GiB |
| `pids.max` | `256` | 16–1024 |
| `cpu.max` | `200000 100000` (2 CPU cores) | positive, at most 8 cores |

The table gives testable examples, **not** sizing recommendations for a real
workload. The kernel must supply actual finite controls, not `max`.

### Preflight from the deployed service's cgroup

```sh
npm run audit:os-quotas
```

The probe reports the actual cgroup membership, limits, current memory and PID
usage, CPU time, and OOM counters. It exits nonzero if the cgroup or any control
is unavailable or invalid. It must execute **inside the same cgroup as the
running service**: running it in an unrelated login shell proves nothing about
the service. This audit deliberately returns `productionCertified: false` even
when the controls are finite.

For the production service itself, enable mandatory startup enforcement:

```sh
PFX_REQUIRE_OS_QUOTAS=1 npm start
```

A failed quota check prevents browser startup. Keep the main server restricted
to loopback while release blockers in `SECURITY.md` remain open.

### Required deployment-specific negative tests (not yet completed)

1. Remove `pids.max` and confirm startup fails without running Chromium.
2. Remove `cpu.max` or set it to `max` and confirm startup fails.
3. Set `memory.max` to `max` and confirm startup fails.
4. Apply quotas and confirm the *browser process* is in the same constrained
   cgroup as the Node service, not merely the Node parent.
5. Under a controlled disposable service, test CPU throttling, PID exhaustion,
   and memory OOM/recovery. Do **not** perform these destructive tests on shared
   GitHub runners or a host running other workloads.
6. Repeat on the **actual** intended production host, document kernel version,
   cgroup mount configuration, observed limits, and the results.

Per-tenant kernel isolation, browser seccomp hardening, and independent security
review remain open issues; the cgroup check alone cannot close them.
