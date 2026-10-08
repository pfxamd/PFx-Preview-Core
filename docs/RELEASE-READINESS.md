# PFx Preview Core — release readiness

## Scope of the candidate

`0.9.0-rc.1` freezes the **local HTTP contract** for internal integration with
PFx Responsive and can be used to begin **frontend development** against the
local loopback service. This is *not* a production hosting release or an
independent security approval.

### Automated gates (must be true on candidate SHA)

- [ ] Syntax / shell validation (`npm run check`).
- [ ] API contract tests (`npm run test:contract`).
- [ ] Entire unit suite (`npm run test:unit`).
- [ ] GitHub Actions real Chromium tests (must have no failures).
- [ ] Browser disconnect and recovery smoke test.
- [ ] Public website compatibility matrix, including detected anti-bot failures.
- [ ] **30-minute** isolated browser lifecycle stability on the **candidate SHA**.
- [ ] Verify no sessions remain after testing.

### Explicitly not yet proven for production

- [ ] Independent SSRF penetration test (subresources, redirects, DNS
      rebinding, proxy bypass, IPv6 and metadata IP ranges).
- [ ] Independent Linux/Chromium sandbox review (capabilities, seccomp, mount
      namespaces, inherited descriptors, file and process access).
- [ ] True per-tenant **kernel** isolation for memory, CPU and PID consumption;
      application-level session/pixel quotas do not provide this.
- [ ] Verify finite memory, CPU and PID cgroup v2 limits on the **deployment
      server**, including real OOM and process exhaustion failure injection.
- [ ] TLS gateway, credential rotation, safe telemetry, egress firewall and
      production incident-response policy.

Do not publish `v1.0.0` or label the current build as secure for a public
multi-user service. Keep HTTP bound to loopback until the open conditions are
independently satisfied. Frontend work can be developed with a trusted local
Core and the documented v1 HTTP contract; do not expose shared secrets in a
public website.
