# PFx Preview Core

Initial independent browser preview runtime. Status: **0.1.0-alpha.1 — experimental**.

Node.js 22+. Install with `npm install`, then `npx playwright install chromium`. Run `npm test` and `npm start`.

API listens on `127.0.0.1:4177` by default.

- `GET /health`
- `POST /sessions` with `{"url":"https://example.com","width":390,"height":844}`
- `POST /resize` with `{"id":"...","width":1280,"height":800}`
- `GET /sessions/:id/screenshot`
- `DELETE /sessions/:id`

**Security:** NOT suitable for public internet deployment. URL inspection and request interception alone do not prevent DNS rebinding and browser-origin SSRF. Requires an independently enforced egress sandbox, authentication, quotas and security audit before remote deployment.

Tests currently mock browsers; actual browser integration, interactive streaming, Firefox/WebKit, multi-device synchronization, browser testing, and hard network isolation remain future work.
