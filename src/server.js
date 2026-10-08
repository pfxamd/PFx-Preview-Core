import { randomBytes } from 'node:crypto';
import { PreviewCore } from './core.js';
import { createPreviewServer } from './http.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4177);
const tenants = process.env.PFX_TENANTS_JSON ? JSON.parse(process.env.PFX_TENANTS_JSON) : undefined;
const token = tenants ? undefined : (process.env.PFX_PREVIEW_TOKEN || randomBytes(32).toString('hex'));
if (!['127.0.0.1', '::1'].includes(host)) {
  throw new Error('Public binding is disabled in this alpha release until independent network isolation is enforced');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
// Each tenant has a hard per-tenant session quota in addition to the global cap.
// The shared-token local mode keeps the previous behavior.
const tenantLimit = tenants ? Number(process.env.PFX_MAX_SESSIONS_PER_TENANT ?? 2) : undefined;
if (tenants && (!Number.isInteger(tenantLimit) || tenantLimit < 1 || tenantLimit > 32)) {
  throw new Error('Invalid PFX_MAX_SESSIONS_PER_TENANT');
}
const tenantPixels = tenants ? Number(process.env.PFX_MAX_PIXELS_PER_TENANT ?? 16_000_000) : undefined;
if (tenants && (!Number.isSafeInteger(tenantPixels) || tenantPixels < 1 || tenantPixels > 48_000_000)) {
  throw new Error('Invalid PFX_MAX_PIXELS_PER_TENANT');
}
const core = new PreviewCore({ config: tenants ? { maxSessionsPerOwner: tenantLimit, maxPixelsPerOwner: tenantPixels } : {} });
await core.start();
const server = createPreviewServer(core, { token, tenants, allowedOrigin: process.env.PFX_ALLOWED_ORIGIN });
const ticker = setInterval(() => core.prune().catch(console.error), 30_000);
server.listen(port, host, () => {
  console.log(`PFx Preview Core at http://${host}:${port}`);
  if (!tenants && !process.env.PFX_PREVIEW_TOKEN) console.log(`Local session token: ${token}`);
  console.warn('EXPERIMENTAL: Do not expose without an independent outbound-network firewall and process sandbox.');
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  server.close();
  await core.stop();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
