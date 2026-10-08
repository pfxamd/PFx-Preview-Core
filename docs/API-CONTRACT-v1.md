# PFx Preview Core — local HTTP API contract v1 (candidate)

**Contract freeze candidate:** `0.9.0-rc.1`. This is the client-facing interface
for building the future **PFx Responsive** frontend. It is **not** a public
hosting or production security certification; the service remains bound to
loopback only. This is the API contract version, not a claim that the kernel or
browser sandbox has completed independent review.

The contract is enforced by `test/api-contract.test.js` in the unit and CI
suites. Changes to endpoint paths, method, payload schema, response shape,
status codes, authorization semantics, PNG format, or SSE frame envelope are
**breaking** and require a newly documented contract version and test update.
Internal Core implementation, browser versions, and additional diagnostics may
change without altering this contract.

## Authentication and deployment boundary

- Default listener: `127.0.0.1:4177`. Non-loopback binding is rejected.
- Recommended for a local multi-user integration: `PFX_TENANTS_JSON` is a
  JSON object mapping tenant IDs to **distinct, strong bearer secrets**.
- Shared-token compatibility mode (`PFX_PREVIEW_TOKEN`) is single-operator
  local use only; it **does not** isolate clients from one another.
- All `/sessions` actions require `Authorization: Bearer <secret>`.
- `PFX_ALLOWED_ORIGIN` explicitly allows a single browser UI origin. Other
  Origin headers are rejected; CORS is **not authentication**.
- Do **not** embed tenant or service bearer secrets in public frontend bundles
  or transmit them directly to third-party sites. The eventual remotely hosted
  tool must implement a trusted, authenticated intermediary before public use.
- Do not connect this service to a public Internet listener or use it for
  hostile multi-user browsing until `SECURITY.md` blockers are resolved.

## JSON and binary endpoint map

| Method | Path | Request JSON | Success response |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `200 {"status":"ok"}`, unauthenticated |
| `POST` | `/sessions` | `{"url":"https://example.com/","width":390,"height":640,"deviceScaleFactor":1}` | `201 {"id":"<uuid>","url":"https://.../","viewport":{"width":390,"height":640},"httpStatus":200}` |
| `POST` | `/sessions/:id/resize` | `{"width":768,"height":1024}` | `200 {"viewport":{"width":768,"height":1024}}` |
| `POST` | `/sessions/:id/navigate` | `{"url":"https://example.com/page"}` | `200 {"url":"https://example.com/page","httpStatus":200}` |
| `POST` | `/sessions/:id/input` | one input event below | `200 {"accepted":true}` |
| `GET` | `/sessions/:id/screenshot` | none | `200 image/png`, raw PNG bytes |
| `GET` | `/sessions/:id/stream` | none | `200 text/event-stream`, events below |
| `DELETE` | `/sessions/:id` | none | `200 {"closed":true}` or `{"closed":false}` |

`width` and `height` default to 1280 and 800 on creation; the device scale
factor defaults to 1. Viewport dimensions must be integers in `[240,3840]`;
the scale factor must be an integer in `[1,3]`. Global and tenant pixel quotas
can impose smaller effective limits. Only HTTP(S) targets are supported; URLs
containing embedded credentials, internal-network targets, unsafe redirects,
and requests to forbidden ports are rejected by the security policy.

`httpStatus` is the browser's **main-document response status**, or `null`
when the driver cannot supply one. A `200` status does not guarantee the
requested site rendered (CAPTCHA and other interstitials can also return 200).
Clients should inspect the screenshot before claiming visual compatibility.

### Input event JSON

- Click: `{"kind":"click","x":120,"y":250}`
- Scroll: `{"kind":"scroll","deltaX":0,"deltaY":430}`
- Type: `{"kind":"type","text":"Sample"}` (at most 4096 characters)
- Key: `{"kind":"key","key":"Enter"}` (at most 80 characters)

### SSE stream

The server starts with `retry: 1500` and sends events of type `frame` with a
JSON `data` field. Its shape is:

```text
event: frame
data: {"mime":"image/jpeg","data":"<base64 JPEG>","metadata":{}}

```

The `data` property is base64 JPEG text from Chromium's event-driven CDP
screencast, **not** a video file or a fixed frame rate. The client must close
its EventSource/connection on teardown and reconnect only if needed. Only one
active stream per session is allowed. The Core enforces per-frame and per-stream
output budgets; streams may terminate once a budget is reached. Never assume
the stream will remain active forever.

## Errors and ownership

Every JSON error has shape `{"error":"message"}`. The contract's status
classes are:

- `400` invalid request payload, URL, dimensions, or input.
- `401` missing/invalid bearer credential.
- `403` Origin not explicitly allowed.
- `404` invalid route, missing session, or another tenant's session; do not
  reveal whether a session is owned by someone else.
- `409` session/pixel quota exhausted, screenshot/stream already active.
- `413` JSON body over 32,768 bytes, or screenshot exceeds configured size.
- `503` Core is stopped or shutting down and cannot accept new sessions.

`DELETE` returns `{ "closed": false }` for both unknown and foreign-owned
session IDs. Clients should not interpret that result as proof of existence.
Standard safety headers include `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`.

## Client integration checklist

1. Keep the bearer credential in a trusted local/client-side secure boundary;
   do not bake it into publicly served JavaScript.
2. Obtain session ID from `POST /sessions`, never guess one.
3. Change viewport via `/resize`; changing `deviceScaleFactor` needs a new
   session in this contract.
4. Handle all non-2xx responses and unexpected stream disconnections.
5. Close screenshot/stream consumers on navigation and dispose each session.
6. Do not infer that a successful screenshot is proof that a website is fully
   reachable, accessible, safe, or functionally correct.

For security limitations and deployment blockers, see `SECURITY.md` and
`docs/OS-RESOURCE-VALIDATION.md`.
