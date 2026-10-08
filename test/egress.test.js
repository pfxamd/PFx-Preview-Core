import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHTTP } from 'node:http';
import { createServer as createTCP, connect as connectTCP } from 'node:net';
import { GuardedEgressProxy } from '../src/egress.js';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
const fakeResolver = async () => [{ address: '8.8.8.8', family: 4 }];
async function sendRaw(hostPort, content) {
  return new Promise((resolve, reject) => {
    let output = '';
    const socket = connectTCP({ host: '127.0.0.1', port: hostPort }, () => socket.write(content));
    socket.setTimeout(4500, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('data', buffer => output += buffer.toString());
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
  });
}

test('egress proxy is bound only to loopback and denies private IPs', async () => {
  const proxy = await new GuardedEgressProxy().start();
  try {
    assert.equal(proxy.server.address().address, '127.0.0.1');
    const denied = await sendRaw(proxy.server.address().port, 'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
    assert.match(denied, /403 Forbidden/);
    const deniedHTTP = await sendRaw(proxy.server.address().port, 'GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(deniedHTTP, /403 Forbidden/);
  } finally { await proxy.stop(); }
});

test('CONNECT permits only HTTPS port 443 and rejects credential injection', async () => {
  const proxy = await new GuardedEgressProxy({ resolver: fakeResolver }).start();
  try {
    for (const authority of ['public.example:22', 'public.example:8443', 'user@public.example:443', 'localhost:443', '[::1]:443']) {
      const text = await sendRaw(proxy.server.address().port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      assert.match(text, /403 Forbidden/, authority);
    }
  } finally { await proxy.stop(); }
});

test('DNS rebinding and mixed public/private DNS are denied at dial time', async () => {
  let calls = 0;
  let dials = 0;
  const proxy = await new GuardedEgressProxy({
    resolver: async () => (++calls === 1 ? [{ address: '8.8.8.8' }] : [{ address: '127.0.0.1' }]),
    dial: () => { dials++; throw new Error('Should not connect'); }
  }).start();
  try {
    await assert.rejects(proxy.openConnection('safe.example', 443));
    assert.equal(dials, 1); // First address was allowed but mocked dial refused.
    await assert.rejects(proxy.openConnection('safe.example', 443), /non-public/);
    assert.equal(dials, 1); // No second dial after DNS rebinding.
  } finally { await proxy.stop(); }
  const mixed = new GuardedEgressProxy({ resolver: async () => [{ address: '8.8.8.8' }, { address: '10.1.2.3' }] });
  await assert.rejects(mixed.resolve('safe.example'), /non-public/);
});

test('HTTP request uses pinned public DNS address, preserves Host and forwards body', async () => {
  let expectedHost; let receivedBody = '';
  const target = createHTTP((req, res) => {
    expectedHost = req.headers.host;
    req.on('data', chunk => receivedBody += chunk);
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture-response'); });
  });
  const port = await listen(target);
  let actualDial;
  const proxy = await new GuardedEgressProxy({ resolver: fakeResolver,
    dial: args => { actualDial = args; return connectTCP({ host: '127.0.0.1', port }); }
  }).start();
  try {
    const raw = await sendRaw(proxy.server.address().port, 'POST http://preview.example/check?x=1 HTTP/1.1\r\nHost: preview.example\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello');
    assert.match(raw, /200 OK/);
    assert.match(raw, /fixture-response/);
    assert.equal(expectedHost, 'preview.example');
    assert.equal(receivedBody, 'hello');
    assert.equal(actualDial.host, '8.8.8.8');
    assert.equal(actualDial.port, 80);
  } finally { await proxy.stop(); await new Promise(resolve => target.close(resolve)); }
});

test('CONNECT tunnel pins IP and conveys bidirectional bytes', async () => {
  const fixture = createTCP(socket => socket.on('data', chunk => socket.write(`echo-${chunk.toString()}`)));
  const port = await listen(fixture);
  const proxy = await new GuardedEgressProxy({ resolver: fakeResolver, dial: () => connectTCP({ host: '127.0.0.1', port }) }).start();
  try {
    await new Promise((resolve, reject) => {
      const client = connectTCP({ host: '127.0.0.1', port: proxy.server.address().port });
      let accumulated = '';
      const timer = setTimeout(() => { client.destroy(); reject(new Error('Timeout waiting for echo')); }, 2500);
      client.on('connect', () => client.write('CONNECT preview.example:443 HTTP/1.1\r\nHost: preview.example:443\r\n\r\n'));
      client.on('data', chunk => {
        accumulated += chunk.toString();
        if (accumulated.includes('200 Connection Established') && !accumulated.includes('echo-ping')) client.write('ping');
        if (accumulated.includes('echo-ping')) { clearTimeout(timer); client.destroy(); resolve(); }
      });
      client.on('error', error => { clearTimeout(timer); reject(error); });
    });
  } finally { await proxy.stop(); await new Promise(resolve => fixture.close(resolve)); }
});

test('connection budget caps sockets', async () => {
  const fixture = createTCP(() => {});
  const port = await listen(fixture);
  const proxy = await new GuardedEgressProxy({ resolver: fakeResolver, maxSockets: 1, dial: () => connectTCP({ host: '127.0.0.1', port }) }).start();
  try {
    const socket = await proxy.openConnection('first.example', 443);
    await assert.rejects(proxy.openConnection('second.example', 443), /limit/);
    socket.destroy(); await wait(40);
    assert.equal(proxy.activeSockets, 0);
  } finally { await proxy.stop(); await new Promise(resolve => fixture.close(resolve)); }
});

test('proxy cannot be used as arbitrary TCP tunnel through HTTP upgrade', async () => {
  const proxy = await new GuardedEgressProxy({ resolver: fakeResolver }).start();
  try {
    const response = await sendRaw(proxy.server.address().port,
      'GET http://preview.example/ HTTP/1.1\r\nHost: preview.example\r\nUpgrade: arbitrary\r\nConnection: Upgrade\r\n\r\n');
    assert.match(response, /403 Forbidden/);
  } finally { await proxy.stop(); }
});

test('HTTP redirect to loopback is denied when followed through egress proxy', async () => {
  const upstream = createHTTP((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); });
  const upstreamPort = await listen(upstream);
  const proxy = await new GuardedEgressProxy({ resolver: fakeResolver,
    dial: () => connectTCP({ host: '127.0.0.1', port: upstreamPort })
  }).start();
  try {
    const first = await sendRaw(proxy.server.address().port,
      'GET http://preview.example/ HTTP/1.1\r\nHost: preview.example\r\nConnection: close\r\n\r\n');
    assert.match(first, /302 Found/);
    assert.match(first, /location: http:\/\/127\.0\.0\.1\/private/i);
    const redirect = await sendRaw(proxy.server.address().port,
      'GET http://127.0.0.1/private HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(redirect, /403 Forbidden/);
  } finally { await proxy.stop(); await new Promise(resolve => upstream.close(resolve)); }
});

test('failed TCP dial destroys socket and releases concurrency budget', async () => {
  const { EventEmitter } = await import('node:events');
  let destroyed = 0;
  const proxy = new GuardedEgressProxy({ resolver: fakeResolver, maxSockets: 1,
    dial: () => {
      const socket = new EventEmitter();
      socket.destroy = () => { destroyed++; socket.emit('close'); };
      process.nextTick(() => socket.emit('error', new Error('dial failed')));
      return socket;
    }
  });
  await assert.rejects(proxy.openConnection('preview.example', 443), /dial failed/);
  assert.equal(destroyed, 1);
  assert.equal(proxy.activeSockets, 0);
});
