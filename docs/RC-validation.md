# Release Candidate Validation

This file records the start of the extended validation for PFx Preview Core 0.7.0-alpha.1.

- Baseline GitHub Actions `Core CI` on commit `b31f57ce7b2675f3cb72267d764aff4d6f26179c`: success.
- The `[rc]` marker in this commit starts the separate `release-gate` job.
- Gate 1: 20 public websites, with at least 15 successful navigation/title/screenshot results.
- Gate 2: 1800 seconds (30 minutes) of browser/stream/session lifecycle soak with browser-disconnect recovery every 20 cycles.
- A successful job does **not** certify production readiness or replace an independent security assessment and per-tenant isolation.
- Release status stays **alpha** until all other conditions in `SECURITY.md` are completed.

Do not publish an official v1.0.0 release just because GitHub Actions is green.
