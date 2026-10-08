import { randomBytes } from 'node:crypto';
import { PreviewCore } from './core.js';
import { createPreviewServer } from './http.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4177);
const token = process.env.PFX_PREVIEW_TOKEN || randomBytes(32).toString('hex');
if (!['127.0.0.1', '::1'].includes(host)) {
  throw new Error('Public binding is disabled in this alpha release until independent network isolation is enforced');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const core = new PreviewCore();
await core.start();
const server = createPreviewServer(core, { token, allowedOrigin: process.env.PFX_ALLOWED_ORIGIN });
const ticker = setInterval(() => core.prune().catch(console.error), 30_000);
server.listen(port, host, () => {
  console.log(`PFx Preview Core at http://${host}:${port}`);
  if (!process.env.PFX_PREVIEW_TOKEN) console.log(`Local session token: ${token}`);
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
