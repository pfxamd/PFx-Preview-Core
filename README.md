# PFx Preview Core

**Status:** `0.3.0-alpha.1` — experimental browser preview runtime. **Not safe for public deployment.**

Independent Node.js browser-control backend for PFx Responsive. Uses native Chromium rendering via `playwright-core`, isolated browser contexts, input events, PNG captures, and live event-driven JPEG frames through Chromium CDP and Server-Sent Events (SSE). No visual frontend is included. An internal **GuardedEgressProxy** now resolves and pins destination IPs for each HTTP/HTTPS connection, rejects private/reserved addresses and disallowed ports, and limits connection counts and idle time.

## Requirements

- Node.js 22+
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
- Browser contexts receive a local proxy. For **HTTP** requests the proxy validates DNS immediately before the socket is opened and connects to that pinned IP while preserving the original `Host`. For **HTTPS**, `CONNECT` is allowed only on port `443`, and the socket is pinned likewise. There is no direct/downgrade fallback specified by PFx.
- **DNS checks are made at the actual proxy connection**, not only when the user first submits the URL. This guards proxy-mediated requests against DNS rebinding and redirects, but does **not** stop a compromised Chromium process or alternate network channels from bypassing the proxy.
- Allowed destination ports are `80` (HTTP/WS) and `443` (HTTPS/WSS). Other ports deliberately fail, so some legitimate websites are not yet compatible.
- Network-level deny rules for the Chromium process are **not implemented**. Production deployment requires a separate sandbox/network namespace and firewall that blocks ALL browser egress except the trusted proxy endpoint, including IPv6/UDP and host-local addresses; the proxy process must run outside that browser sandbox. Never expose this alpha release publicly.

## Testing

- Unit, security, proxy, and HTTP tests: `npm test`
- Real browser tests: `PFX_RUN_BROWSER=1 npm test` after installing Chromium with the Playwright CLI
- Existing system executable: `PFX_CHROMIUM_PATH=/usr/bin/chromium npm test`
- External navigation smoke test (requires unrestricted DNS and outbound HTTPS): `PFX_RUN_BROWSER=1 PFX_RUN_EXTERNAL=1 npm test`
- GitHub Actions runs unit and real Chromium tests on push. An external-site smoke test also runs on pushes (and can be retriggered via workflow dispatch). An external failure is a genuine CI blocker; do not silently mark it successful.

**Covered in local unit/socket tests:** browser process start/stop; real DOM interaction, viewports, screenshots, CDP JPEG frames, server SSE delivery, session-cookie separation; bearer auth, origin rejection, invalid URLs, blocked private/reserved IPs, mixed public/private DNS, session capacity, lifecycle.

**Not yet proven:** real external-site navigation in the restricted local testing environment; full compatibility with websites that require login/MFA, DRM or block automation; Firefox/WebKit; cross-device input synchronization; production load capacity.

## Security boundary — read before deploying

This is a prototype for trusted local testing only. **Public bind is deliberately disabled.** Do not bypass this restriction until independent protections are deployed and audited. The in-process URL validator, DNS check and Playwright request routing are only defense-in-depth: they **cannot** prevent DNS rebinding or independently enforce browser outbound-network policy. Browser sub-processes may create network channels not covered by routing.

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
