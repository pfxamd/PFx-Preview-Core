import { createServer } from 'node:http';
import { PreviewCore } from './core.js';

const core = new PreviewCore();
const token = process.env.PFX_PREVIEW_TOKEN;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4177);
if (host !== '127.0.0.1' && host !== '::1' && (!token || token.length < 24)) throw new Error('External bind requires a 24+ character PFX_PREVIEW_TOKEN');
await core.start();
const server = createServer(async (req, res) => {
  const send = (status, body, contentType = 'application/json') => {
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(contentType === 'application/json' ? JSON.stringify(body) : body);
  };
  if (req.url === '/health' && req.method === 'GET') return send(200, { status: 'ok', sessions: core.sessions.size });
  if (token && req.headers.authorization !== 'Bearer ' + token) return send(401, { error: 'Unauthorized' });
  try {
    if (req.method === 'POST' && ['/sessions', '/resize'].includes(req.url)) {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('Request too large'); }
      const data = JSON.parse(raw);
      if (req.url === '/sessions') return send(201, await core.create(data));
      return send(200, await core.resize(data.id, data));
    }
    const match = /^\/sessions\/([a-f0-9-]+)(\/screenshot)?$/.exec(req.url || '');
    if (match && req.method === 'DELETE' && !match[2]) return send(200, { closed: await core.close(match[1]) });
    if (match && req.method === 'GET' && match[2]) return send(200, await core.screenshot(match[1]), 'image/png');
    return send(404, { error: 'Not found' });
  } catch (e) { return send(400, { error: e.message }); }
});
const ticker = setInterval(() => core.prune().catch(console.error), 30000);
server.listen(port, host, () => console.log('PFx Preview Core listening on ' + host + ':' + port));
async function shutdown() { clearInterval(ticker); server.close(); await core.stop(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
