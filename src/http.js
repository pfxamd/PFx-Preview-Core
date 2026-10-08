import { createServer } from 'node:http';
import { createAuthenticator } from './auth.js';

function statusFor(error) {
  if (/not found/i.test(error.message)) return 404;
  if (/Core is not accepting sessions|Core is shutting down/i.test(error.message)) return 503;
  if (/capacity|already active|pixel budget/i.test(error.message)) return 409;
  if (/body too large|screenshot size limit/i.test(error.message)) return 413;
  return 400;
}

export function createPreviewServer(core, { token, tenants, allowedOrigin = null } = {}) {
  const authenticate = createAuthenticator({ token, tenants });
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return;
    }
    const headers = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(origin && allowedOrigin ? { 'access-control-allow-origin': allowedOrigin, vary: 'Origin' } : {})
    };
    const send = (status, payload, type = 'application/json') => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
    if (req.method === 'OPTIONS' && origin === allowedOrigin && allowedOrigin) {
      res.writeHead(204, {
        ...headers, 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600'
      });
      res.end(); return;
    }
    const identity = authenticate(req.headers.authorization);
    if (!identity) return send(401, { error: 'Unauthorized' });
    const { owner } = identity;
    const readBody = async () => {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32_768) throw new Error('Request body too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected JSON object');
      return body;
    };
    try {
      if (req.method === 'POST' && req.url === '/sessions') return send(201, await core.create({ ...await readBody(), owner }));
      const match = /^\/sessions\/([a-f\d-]{36})(?:\/(screenshot|stream|resize|input|navigate))?$/.exec(req.url || '');
      if (!match) return send(404, { error: 'Not found' });
      const [, id, action] = match;
      if (req.method === 'DELETE' && !action) return send(200, { closed: await core.close(id, owner) });
      if (req.method === 'GET' && action === 'screenshot') return send(200, await core.screenshot(id, owner), 'image/png');
      if (req.method === 'POST' && action === 'resize') return send(200, await core.resize(id, await readBody(), owner));
      if (req.method === 'POST' && action === 'input') return send(200, await core.input(id, await readBody(), owner));
      if (req.method === 'POST' && action === 'navigate') {
        const { url } = await readBody();
        return send(200, await core.navigate(id, url, owner));
      }
      if (req.method === 'GET' && action === 'stream') {
        // Verify before sending headers, so missing sessions return JSON 404.
        core.get(id, owner);
        if (core.get(id, owner).stream) return send(409, { error: 'Stream already active' });
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'connection': 'keep-alive' });
        res.write('retry: 1500\n\n');
        let writable = true;
        res.on('drain', () => { writable = true; });
        let close = null;
        const onFrame = frame => {
          if (!writable || res.destroyed || res.writableEnded) return;
          writable = res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
        };
        try {
          close = await core.stream(id, onFrame, { onStop: () => { if (!res.destroyed && !res.writableEnded) res.end(); } }, owner);
          if (res.destroyed) await close();
          else res.once('close', () => { void close(); });
        } catch (error) {
          if (close) await close();
          res.end(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        }
        return;
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      send(statusFor(error), { error: error.message });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
