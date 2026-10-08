# Release Candidate Validation — PFx Preview Core

## Previous release-gate evidence

- CI run: https://github.com/pfxamd/PFx-Preview-Core/actions/runs/37765276471
- Commit: `680dd3d85b1065454f810f0fc805dc1ba9f21da1`
- Result: GitHub Actions succeeded for unit, browser-validation and release-gate.
- Initial 20-site matrix: 19 reported PASS, 1 reported FAIL (`www.gnu.org`, title absent).
- **Audit correction**: `www.w3.org` yielded a Cloudflare `Just a moment...` challenge page, which the old title/screenshot-only matrix incorrectly reported as PASS. Thus **at most 18 of the 20** were demonstrated to display genuine, titled site content. Challenge completion was not shown.
- 30-minute stability gate: 1,801 seconds elapsed; 2,021 lifecycle cycles, 8,084 clicks, 2,021 screenshots, 4,042 streamed frames, 101 browser restarts, 0 remaining sessions, status PASS.

## Regression and future release requirements

- As of `0.7.0-alpha.2`, classify known challenge/interstitial titles, challenge redirects/DOM markers and non-2xx main-document statuses as incompatible, with direct unit tests.
- Verify the corrected 20-site matrix on GitHub Actions. Because anti-bot response content changes, never infer the corrected pass count from the previous run.
- The gate accepts at least 15 sites as a diagnostic threshold; this does not promise compatibility with any given domain.
- CI is **not** an independent security audit, verified production cgroup isolation, seccomp assessment, tenant-scoped authorization or proof of production readiness.
- Keep public binding disabled, retain status Alpha, and do not issue an official v1.0.0 release until the blockers in `SECURITY.md` have been satisfied.
