import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PreviewClient, PreviewAPIError } from '../src/client.js';

const token = 'local-integration-token-1234567890';
const id = '11111111-2222-3333-4444-555555555555';

async function withServer(handle, run) {
  const server = createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new PreviewClient({ baseURL: `http://127.0.0.1:${server.address().port}`, token });
  try { await run(client); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('client refuses external URLs, credentials and malformed session IDs', async () => {
  for (const baseURL of ['https://example.com', 'http://evil.example', 'http://127.0.0.1:4177/other', 'http://admin:secret@localhost:4177']) {
    assert.throws(() => new PreviewClient({ baseURL, token }), /loopback/);
  }
  const client = new PreviewClient({ token });
  await assert.rejects(() => client.screenshot('invalid-id'), /Invalid session ID/);
});

test('client uses authorization headers for API operations, not URL parameters', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, method: req.method });
    if (req.url === '/sessions' && req.method === 'POST') return json(res, 201, { id });
    if (req.url.endsWith('/screenshot')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from([137, 80, 78, 71]));
    }
    if (req.method === 'DELETE') return json(res, 200, { closed: true });
    return json(res, 200, { accepted: true });
  }, async client => {
    assert.deepEqual(await client.create({ url: 'https://example.com/' }), { id });
    assert.deepEqual(await client.input(id, { kind: 'click', x: 2, y: 3 }), { accepted: true });
    assert.deepEqual([...await client.screenshot(id)], [137, 80, 78, 71]);
    assert.deepEqual(await client.close(id), { closed: true });
  });
  assert.equal(seen.length, 4);
  assert.ok(seen.every(x => x.authorization === `Bearer ${token}` && !x.url.includes(token)));
});

test('client throws structured API errors without silently retrying', async () => {
  await withServer((_req, res) => json(res, 409, { error: 'Session capacity reached' }), async client => {
    await assert.rejects(client.create({}), error => error instanceof PreviewAPIError && error.status === 409 && /capacity/.test(error.message));
  });
});

test('client reads fragmented SSE frames and closes stream when consumer exits', async () => {
  let serverStreamClosed;
  const closed = new Promise(resolve => { serverStreamClosed = resolve; });
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('retry: 1500\n\nevent: fr');
    res.write('ame\ndata: {"mime":"image/jpeg","data":"Zm9v","metadata":{}}\n\n');
    res.once('close', serverStreamClosed);
  }, async client => {
    const events = [];
    for await (const frame of client.stream(id)) { events.push(frame); break; }
    assert.deepEqual(events, [{ mime: 'image/jpeg', data: 'Zm9v', metadata: {} }]);
  });
  await closed;
});

test('client reports server-sent SSE errors', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: error\ndata: {"error":"Core stream interrupted"}\n\n');
  }, async client => {
    await assert.rejects(async () => { for await (const _ of client.stream(id)) {} }, /Core stream interrupted/);
  });
});

test('client rejects oversized SSE lines without delivering frames', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: frame\ndata: ${'x'.repeat(16 * 1024 * 1024 + 1)}\n\n`);
  }, async client => {
    await assert.rejects(async () => { for await (const _ of client.stream(id)) {} }, /stream line too large/);
  });
});

test('client rejects malformed SSE frames', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: frame\ndata: {invalid}\n\n');
  }, async client => {
    await assert.rejects(async () => { for await (const _ of client.stream(id)) {} }, /Malformed stream frame/);
  });
});

test('client never follows redirects with bearer credentials', async () => {
  let receivedByTarget = false;
  const target = createServer((_req, res) => {
    receivedByTarget = true;
    res.end('should not arrive');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  try {
    await withServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/credentials` });
      res.end();
    }, async client => {
      await assert.rejects(client.create({ url: 'https://example.com/' }), /redirect|fetch failed/i);
    });
    assert.equal(receivedByTarget, false);
  } finally {
    target.closeAllConnections();
    await new Promise(resolve => target.close(resolve));
  }
});
