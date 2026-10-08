# PFx Preview Core — security model and release blockers

**Status: experimental local-only runtime. Public deployment is intentionally disabled.** This is a developer review, **not an independent penetration test or security certification**.

## Boundaries

- Incoming API: default is a single-operator localhost process protected by a shared bearer token. An experimental optional tenant-credential mode now binds each session to its authenticated owner, checks ownership on screenshot/stream/input/navigation/resize/delete, and enforces per-owner session slots and rendering-pixel quotas (including pending/closing reservations). This remains **local-only and unsuitable for mutually untrusted users** until process/OS/tenant quotas and deployment security reviews are completed.
- Target URLs: preflight screening and the guarded egress proxy reject private/reserved IP addresses, non-HTTP(S) URLs, and unauthorized ports. DNS is resolved before proxy connection and the approved IP is pinned for that connection.
- Browser: Linux user/mount/PID/network namespaces, chrooted temporary mount root, read-only runtime and browser files, capability and privilege reduction, no direct network routes; communication to host proxy only through a restricted UNIX socket.
- Resource policy: viewport, session counts and per-tenant rendering pixels are application quotas, **not kernel memory/CPU quotas**. The optional `PFX_REQUIRE_OS_QUOTAS=1` flag checks finite cgroup v2 quotas placed on the **entire parent service** by the operator. It cannot create quotas.
- Streaming output: each CDP screencast stream has a default maximum of 8 MiB of base64 JPEG data per frame and 512 MiB of encoded JPEG data cumulatively. Over-budget streams are stopped and detached before further frames are forwarded. This is **not** a global throughput quota, rate limiter or a per-tenant bandwidth budget; streaming abuse controls are still required for remote deployment.
- The browser still runs real untrusted JavaScript and Chromium contains a large attack surface; namespace/chroot isolation is only defense in depth. OS policy must also include seccomp and verified process/user separation before a multi-user service.
- Compatibility diagnostics now distinguish actual page navigation from common CAPTCHA/anti-bot interstitials and HTTP errors. A successful screenshot or a document title is **not** proof that the original site rendered. Challenge detection is heuristic and can miss novel interstitials; it never bypasses site restrictions.

## Pending requirements before any public production release

1. Independent adversarial test of SSRF (IPv4/IPv6, redirects, subresources, WebSockets, DNS rebinding, browser bypasses, metadata IP ranges).
2. Independent Linux sandbox review, especially mount propagation, file descriptor inheritance, capabilities, PID cleanup, and seccomp policy.
3. **Tenant-scoped ownership is implemented in the local API**, but it still requires an independently audited external identity provider, credential rotation/revocation, per-tenant OS process/CPU/memory isolation, abuse detection and real-world adversarial verification before multi-user release.
4. Verify cgroup v2 limits in the **actual deployment**, e.g. memory.max, cpu.max, pids.max, and behaviour under OOM/PID exhaustion. CI synthetic memory snapshots are not those proofs.
5. External HTTPS compatibility matrix with observed failures classified; browser crash and connection-drop recovery; 30-minute reliability gate and regression tests.
6. TLS at an external terminating gateway, key rotation, logs without URLs with embedded secrets, limits on downloaded/streamed data, and dependency/Chromium security update policy.

## Release gates and claims

- `unit` and `browser-validation` CI jobs must pass on the proposed commit.
- On a commit with `[rc]` (or manual workflow dispatch), `release-gate` tests 20 public sites and then cycles the isolated runtime for 1,800 seconds. It is a **test**, not proof of 100% compatibility, and is not completed until GitHub marks it successful.
- The experimental alpha may be advanced when these automated checks pass. **Do not tag v1.0.0 or v1.0.0-rc.1 as a production-ready release** before the independent review and deployment-specific resource tests.

## Incident handling

The default HTTP server listens on loopback only. Preserve this restriction. If a publicly accessible deployment is accidentally created, shut it down and rotate API credentials before resuming development.

## OS resource probe (implemented; deployment verification pending)

- `npm run audit:os-quotas` reads **real** Linux cgroup v2 memory, PID and CPU
  limits plus usage and OOM counters; missing or unlimited limits return a
  nonzero exit code rather than a passing result.
- `PFX_REQUIRE_OS_QUOTAS=1` verifies finite quotas at real-browser startup.
- These checks do **not** install quotas, provide per-tenant kernel isolation,
  or certify the service. See `docs/OS-RESOURCE-VALIDATION.md` for the actual
  production-host verification requirements.

## Asynchronous close race hardening (`0.8.0-alpha.4`)

A session close now prevents queued resizes, late URL validation results and delayed CDP allocations from opening additional work for an already closed session. Quota reservations are snapshotted before teardown to avoid drifting counts if an in-flight resize fails. These checks are verified in unit tests but are not a sandbox or a substitute for external security assessment.

## Stream output budgets (`0.8.0-alpha.5`)

The core rejects invalid CDP streaming options and closes a stream when a single encoded frame or the cumulative encoded JPEG payload exceeds its configured limit. Client disconnect callbacks cannot strand the CDP session during cleanup. This reduces output amplification from long-lived streams but does not restrict total network traffic across repeated streams or provide independent tenant-level bandwidth isolation.

## Screenshot output budget (`0.8.0-alpha.6`)

PNG screenshots have a 48 MiB default response limit (`maxScreenshotBytes`),
with a hard configurable upper bound of 64 MiB. The core permits only one
in-flight capture per session, rejects captures completed after their session
closes, and responds with HTTP 413 when an image exceeds the configured limit.
The limit applies **after Chromium finishes encoding** and is not a hard bound
on screenshot encoding memory. Per-tenant aggregate screenshot bandwidth and
host-level CPU/RAM controls are still required before public deployment.

## Candidate HTTP API contract (`0.9.0-rc.1`)

The local JSON/PNG/SSE protocol is frozen for integration tests as specified
in `docs/API-CONTRACT-v1.md`. Contract tests exercise authentication, tenant
non-disclosure, response payloads, errors, lifecycle, and refusal when the
Core is unavailable. The release candidate is for internal tool development;
**do not** infer independent security approval, actual production-host resource
isolation, or safe public multi-user deployment from an API contract freeze.
See `docs/RELEASE-READINESS.md`.

## Authenticated local integration (0.9.0-rc.2)

The optional `PreviewClient` helper enforces loopback HTTP addresses and
refuses redirects so bearer credentials cannot be forwarded to a remote
location by following a malicious HTTP redirect. Its SSE connection uses
`fetch()` with an `Authorization` header, because native browser EventSource
cannot carry the required header. Do not embed this token in public UI bundles
or put it in URLs. The helper is **not** an independently reviewed security
boundary and is not safe public-hosting middleware.

### Windows portable mode

The opt-in Windows runtime (`PFX_LOCAL_WINDOWS=1`) is single-operator and loopback-only. It preserves URL checks and the guarded DNS-pinned proxy but **does not provide the Linux kernel namespaces, chroot, OS egress firewall, or per-tenant process isolation**. No untrusted tenant mode or public hosting is permitted. Never treat successful Windows functional tests as sandbox validation.
