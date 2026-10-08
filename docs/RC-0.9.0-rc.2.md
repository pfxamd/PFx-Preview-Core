# PFx Preview Core 0.9.0-rc.2 — validation record

The candidate source is commit `65483c4a9c7744e038ae6e4ce46005720f432cbd`.

This [rc] documentation commit starts a new GitHub Actions release-gate on the exact current tree. The candidate:
- Preserves the v1 local JSON/PNG/SSE HTTP contract.
- Adds a local authenticated `fetch` and streaming client with no external dependencies.
- Runs the unit and real Chromium regressions, a 20-site compatibility matrix and an 1,800-second isolated browser stability test.
- Must classify anti-bot challenge pages as failures rather than successful renders.

Preliminary CI on the source commit: 85 unit tests passed; real Chromium suite: 101 passed, 3 skipped, zero failed; 6/6 external smoke tests passed. Release-gate results are **not yet known** at the time of this commit.

**Blocking production readiness:** independent adversarial SSRF/sandbox review; real deployment CPU/RAM/PID limits and per-tenant kernel isolation; TLS gateway, credential rotation and abuse controls. The API client is for trusted loopback integrations only. Do not announce a production release until these are independently verified.

Refer to `docs/API-CONTRACT-v1.md`, `docs/RELEASE-READINESS.md`, and `SECURITY.md`.
