# PFx Preview Core

**Status:** `0.5.0-alpha.1` — experimental browser preview runtime. **Not safe for public deployment.**

Independent Node.js browser-control backend for PFx Responsive. Uses native Chromium rendering via `playwright-core`, isolated browser contexts, input events, PNG captures, and live event-driven JPEG frames through Chromium CDP and Server-Sent Events (SSE). No visual frontend is included. An internal **GuardedEgressProxy** resolves and pins destination IPs for each HTTP/HTTPS connection, rejects private/reserved addresses and disallowed ports, and limits connection counts and idle time. On Linux the default Chromium launcher runs in a **separate user/network namespace with zero outbound routes**; it reaches the guarded host-side proxy only through a private UNIX socket bridge.

## Requirements

- Node.js 22+ on Linux with unprivileged user+network namespaces enabled, `unshare` from util-linux and `/usr/sbin/ip` from iproute2
- This alpha **fails closed** when Linux namespace creation is unavailable: it never falls back to unrestricted Chromium networking.
- Install: `npm install`
- Download compatible Chromium: `npx playwright-core install chromium`
- Start: `npm start` (binds to `127.0.0.1:4177` and prints a temporary local bearer token)
- Optional system Chromium: set `PFX_CHROMIUM_PATH=/path/to/chromium`
- Optional API settings: `PORT`, `PFX_PREVIEW_TOKEN` (24+ characters), `PFX_ALLOWED_ORIGIN` (exact origin). `HOST` must be loopback in this alpha release.

All non-health API requests require `Authorization: Bearer <token>`. Browsers making cross-origin requests are denied by default; configure one exact origin if needed. No wildcard CORS.

## HTTP API

| Method | Endpoint | Body / result |
| --- | --- | --- |
| GET | `/health` | Basic liveness |
| POST | `/sessions` | `{ "url":"https://example.com", "width":390, "height":844 }` → session ID |
| POST | `/sessions/:id/resize` | `{ "width":1280, "height":800 }` |
| POST | `/sessions/:id/navigate` | `{ "url":"https://example.com/page" }` |
| POST | `/sessions/:id/input` | `{ "kind":"click", "x":80, "y":120 }`, `{ "kind":"type", "text":"Hello" }`, `{ "kind":"scroll", "deltaX":0, "deltaY":500 }` or `{ "kind":"key", "key":"Enter" }` |
| GET | `/sessions/:id/screenshot` | PNG image |
| GET | `/sessions/:id/stream` | SSE `frame` events: JSON with `mime`, base64 `data`, and CDP `metadata` |
| DELETE | `/sessions/:id` | Closes context and stream |

The stream is **event-driven**, not a guaranteed fixed-FPS video. CDP screencast works on Chromium; other browser engines need a separate adapter. SSE is read with `fetch` streaming and bearer authorization, not plain `EventSource` (which cannot set bearer headers).

## Network policy

- **Local-only experimental release.** The API refuses non-loopback binding; the egress proxy itself binds only to `127.0.0.1`.
- Browser subprocesses are launched with `unshare --user --map-root-user --net --fork`. The new namespace has **no external network routes** and a loopback listener for a relay. The relay connects through an owner-only UNIX socket to a host-side bridge and finally the guarded proxy. The browser has no direct host loopback or public network connection.
- Browser contexts receive the **namespace-local proxy**. For **HTTP** requests the proxy validates DNS immediately before the socket is opened and connects to that pinned IP while preserving the original `Host`. For **HTTPS**, `CONNECT` is allowed only on port `443`, and the socket is pinned likewise. There is no direct/downgrade fallback specified by PFx.
- **DNS checks are made at the actual proxy connection**, not only when the user first submits the URL. This guards proxy-mediated requests against DNS rebinding and redirects. The independent network namespace prevents raw IPv4/IPv6/UDP egress, but does not yet provide a fully restricted filesystem, CPU/memory cgroups, or per-tenant host user separation.
- Allowed destination ports are `80` (HTTP/WS) and `443` (HTTPS/WSS). Other ports deliberately fail, so some legitimate websites are not yet compatible.
- **OS-level network isolation is implemented and locally tested** using a Linux user/network namespace with no routes and a UNIX socket relay. Public deployment is still disabled pending OS-level filesystem/process restrictions, real-browser proxy integration results on CI, resource limits, and an independent security audit. Never expose this alpha release publicly.

## Testing

### Load and lifecycle verification (experimental)

- Browser rendering benchmark: `PFX_CHROMIUM_PATH=/usr/bin/chromium npm run bench:load` (10, 25, 50 lightweight contexts, with screenshot and DOM interaction).
- Full isolated Core API benchmark: `npm run bench:isolated` (10, 25, 50 sessions through `PreviewCore.create`, pinned DNS egress proxy, real Chromium, click/screenshot and sampled CDP frames). This requires a Linux environment where network namespace navigation succeeds. GitHub Actions runs this separately on `workflow_dispatch` or on a commit whose message includes `[load]`.
- Both benchmarks enforce a memory safety cutoff and report a failure rather than treating incomplete tiers as a pass. **These are synthetic tests, not public-site capacity guarantees.**
- Core enforces 4 concurrent sessions by default, a 12-million-pixel limit per viewport, a 48-million-pixel total session budget, and a 30-minute maximum session lifetime. Raising `maxSessions` alone is not sufficient to increase physical capacity; host CPU/RAM, video streaming and application complexity still impose hard limits.
- Shutdown waits for pending navigations to finish (and refuses new sessions), safely tears down proxy/namespace resources after crashes, and evicts long-lived streams. Tests cover concurrent startup/shutdown, recovery, pixel quotas and in-flight reservations.

- Unit, network-namespace, security, proxy, and HTTP tests: `npm test`
- Real browser tests: `PFX_RUN_BROWSER=1 npm test` after installing Chromium with the Playwright CLI
- Existing system executable: `PFX_CHROMIUM_PATH=/usr/bin/chromium npm test`
- External navigation smoke test (requires unrestricted DNS and outbound HTTPS): `PFX_RUN_BROWSER=1 PFX_RUN_EXTERNAL=1 npm test`
- GitHub Actions runs unit and real Chromium tests on push. An external-site smoke test also runs on pushes (and can be retriggered via workflow dispatch). An external failure is a genuine CI blocker; do not silently mark it successful.

**Covered in local unit/socket tests:** namespace no-route enforcement, direct host/Internet connection denial, bridge-only permitted path, browser process start/stop; real DOM interaction, viewports, screenshots, CDP JPEG frames, server SSE delivery, session-cookie separation; bearer auth, origin rejection, invalid URLs, blocked private/reserved IPs, mixed public/private DNS, session capacity, lifecycle.

**Not yet proven:** real external-site navigation in the restricted local testing environment; full compatibility with websites that require login/MFA, DRM or block automation; Firefox/WebKit; cross-device input synchronization; production load capacity.

## Security boundary — read before deploying

This is a prototype for trusted local testing only. **Public bind is deliberately disabled.** Do not bypass this restriction until filesystem isolation, authenticated multi-user session ownership, OS resource limits, threat modeling, and independent security review are complete. An isolated Linux network namespace restricts direct Chromium egress; the in-process URL checks and Playwright routing remain defense-in-depth and must never be regarded as the security boundary.

For public hosting, require at minimum:

1. An independently enforced browser egress policy (IPv4 and IPv6) blocking loopback, RFC1918/link-local, metadata services, internal control planes, and unauthorized ports and protocols. Handle DNS rebinding and redirects at the network boundary, not only JavaScript URL checks.
2. Per-tenant browser process isolation, OS sandboxing, resource quotas, timeouts, and restricted file system mounts. Never attach host credentials or cloud metadata access.
3. TLS, scoped authentication, abuse controls, concurrency/memory limits, observability, secure secret handling, and regular patching.
4. Security review and real adversarial SSRF testing inside the intended deployment architecture.

### Known limitations

- Third-party site authentication, anti-bot restrictions, CAPTCHAs, and licensed media can still prevent loading.
- Real mobile hardware quirks are not perfectly simulated by Chromium viewport settings.
- This is **not** a tool for evading access controls.
- The development environment blocks Chromium navigation and external DNS. DOM rendering, screenshot, input and streaming are tested against in-memory fixtures. Browser navigation via the proxy and redirect behavior are **skipped with an explicit reason** if the environment blocks requests before reaching the proxy. GitHub Actions sets `PFX_REQUIRE_BROWSER_NETWORK=1` so a blocked proxy/browser navigation **fails** CI instead of silently skipping. External smoke tests also fail CI when the public targets are unreachable.


## Linux namespace architecture (`0.4.0-alpha.1`)

```text
Chromium + Node relay (unshared Linux user/network namespace; no routes)
    | local HTTP proxy on 127.0.0.1:34177 inside namespace
    v
Private Unix-domain socket (mode 0600; parent directory mode 0700)
    | accepted only by trusted host-side bridge
    v
GuardedEgressProxy (host network namespace; pinned DNS/IP; port 80/443 only)
    v
Public destination
```

The Chromium child receives a **minimal environment allowlist** rather than server tokens. The relay, bridge, and guarded proxy shut down with the core. Platform requirements are intentionally strict; a host that forbids user namespaces cannot start the real-browser engine.

**Verification status:** Previous GitHub Actions run [Core CI #8](https://github.com/pfxamd/PFx-Preview-Core/actions/runs/37757983575) passed real external HTTPS navigation and Chromium integration. New 10/25/50-session full-Core load test results must be checked in their own run. The OS-level isolation protects network paths only, **not filesystem access, fork/CPU exhaustion, process privileges, or renderer escapes**. Public deployment remains prohibited until those boundaries are independently secured and tested.
