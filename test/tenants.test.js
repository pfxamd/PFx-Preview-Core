import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PreviewCore } from '../src/core.js';
import { createPreviewServer } from '../src/http.js';
import { createAuthenticator } from '../src/auth.js';

const alice = 'alice-secret-token-valid-12345678901';
const bob = 'bob-secret-token-valid-1234567890123';
const credentials = { alice, bob };

function makeCore(config = {}) {
  let closed = 0;
  const core = new PreviewCore({
    browserFactory: async () => ({
      newContext: async () => {
        const page = {
          goto: async () => null, url: () => 'https://example.com/',
          viewportSize: () => ({ width: 390, height: 640 }),
          setViewportSize: async () => {}, screenshot: async () => Buffer.from('PNG'),
          keyboard: { insertText: async () => {}, press: async () => {} },
          mouse: { click: async () => {}, wheel: async () => {} }
        };
        return { route: async () => {}, newPage: async () => page, close: async () => { closed++; } };
      }, close: async () => {}
    }), validate: async url => url,
    config: { maxSessions: 4, maxSessionsPerOwner: 1, ...config }
  });
  return { core, getClosed: () => closed };
}

const options = (secret, method = 'GET', data) => ({
  method, headers: { authorization: `Bearer ${secret}`, ...(data ? { 'content-type': 'application/json' } : {}) },
  ...(data ? { body: JSON.stringify(data) } : {})
});

async function withServer(config, run) {
  const { core, getClosed } = makeCore(config);
  await core.start();
  const server = createPreviewServer(core, { tenants: credentials });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ core, getClosed, base: `http://127.0.0.1:${server.address().port}` }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await core.stop();
  }
}

test('invalid or duplicated tenant credentials are rejected at startup', () => {
  assert.throws(() => createAuthenticator({ tenants: { alice: 'short' } }), /Invalid/);
  assert.throws(() => createAuthenticator({ tenants: { alice, bob: alice } }), /Duplicate/);
  assert.throws(() => createAuthenticator({ token: alice, tenants: credentials }), /Shared token/);
  assert.throws(() => createAuthenticator({ tenants: {} }), /Invalid/);
  assert.equal(createAuthenticator({ tenants: credentials })('Bearer missing'), null);
  assert.equal(createAuthenticator({ tenants: credentials })(`Bearer ${bob}`)?.owner, 'bob');
  assert.deepEqual(createAuthenticator({ token: alice })(`Bearer ${alice}`), { owner: null });
});

test('tenant credentials enforce ownership for every HTTP session action', async () => {
  await withServer({}, async ({ core, base, getClosed }) => {
    const r = await fetch(`${base}/sessions`, options(alice, 'POST', { url: 'https://example.com/', width: 390, height: 640, owner: 'bob' }));
    assert.equal(r.status, 201);
    const { id } = await r.json();
    assert.equal(core.get(id, 'alice').owner, 'alice'); // spoofed owner ignored
    assert.throws(() => core.get(id, 'bob'), /not found/i);
    let validations = 0;
    const originalValidate = core.validate;
    core.validate = async url => { validations++; return originalValidate(url); };
    for (const [method, action, body] of [
      ['GET', 'screenshot'],
      ['GET', 'stream'],
      ['POST', 'resize', { width: 600, height: 800 }],
      ['POST', 'input', { kind: 'click', x: 20, y: 20 }],
      ['POST', 'navigate', { url: 'https://example.com/' }]
    ]) {
      const denied = await fetch(`${base}/sessions/${id}/${action}`, options(bob, method, body));
      assert.equal(denied.status, 404, `${method} ${action}`);
    }
    assert.equal(validations, 0, 'unauthorized navigation must not resolve external hostnames');
    const deniedDelete = await fetch(`${base}/sessions/${id}`, options(bob, 'DELETE'));
    assert.deepEqual(await deniedDelete.json(), { closed: false });
    assert.equal(core.sessions.size, 1);
    assert.equal(getClosed(), 0);
    assert.equal((await fetch(`${base}/sessions/${id}/screenshot`, options(alice))).status, 200);
    assert.equal((await fetch(`${base}/sessions/${id}`, options(alice, 'DELETE'))).status, 200);
    assert.equal(getClosed(), 1);
  });
});

test('tenant capacity is enforced atomically across pending and closing sessions', async () => {
  await withServer({}, async ({ core, base }) => {
    const create = async (secret) => fetch(`${base}/sessions`, options(secret, 'POST', { url: 'https://example.com/', width: 390, height: 640 }));
    const a = await create(alice);
    assert.equal(a.status, 201);
    const idA = (await a.json()).id;
    assert.equal((await create(alice)).status, 409);
    const b = await create(bob);
    assert.equal(b.status, 201);
    const idB = (await b.json()).id;
    assert.equal((await create(bob)).status, 409);
    assert.equal(core.sessions.size, 2);
    await fetch(`${base}/sessions/${idA}`, options(alice, 'DELETE'));
    assert.equal((await create(alice)).status, 201);
    assert.equal((await create(bob)).status, 409);
    await fetch(`${base}/sessions/${idB}`, options(bob, 'DELETE'));
  });
});

test('single-operator mode remains compatible without accepting spoofed owners', async () => {
  const { core } = makeCore();
  await core.start();
  const server = createPreviewServer(core, { token: alice });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/sessions`, options(alice, 'POST', { url: 'https://example.com/', owner: 'bob' }));
    assert.equal(response.status, 201);
    assert.equal(core.get((await response.json()).id).owner, null);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await core.stop();
  }
});

test('tenant slot reservations include pending navigations of the same owner', async () => {
  const { core } = makeCore({ maxSessions: 3, maxSessionsPerOwner: 1 });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  core.validate = async url => { await wait; return url; };
  await core.start();
  try {
    const first = core.create({ url: 'https://example.com/', owner: 'alice' });
    await assert.rejects(core.create({ url: 'https://example.com/', owner: 'alice' }), /Tenant capacity/);
    const second = core.create({ url: 'https://example.com/', owner: 'bob' });
    assert.equal(core.activeFor('alice'), 1);
    assert.equal(core.activeFor('bob'), 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.notEqual(a.id, b.id);
    await Promise.all([core.close(a.id, 'alice'), core.close(b.id, 'bob')]);
    assert.equal(core.pendingOwners.size, 0);
  } finally { release(); await core.stop(); }
});

test('tenant slots cannot be reused while a close is pending and other tenant cannot close it', async () => {
  const { core } = makeCore({ maxSessions: 2, maxSessionsPerOwner: 1 });
  await core.start();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  try {
    const { id } = await core.create({ url: 'https://example.com/', owner: 'alice' });
    const context = core.get(id, 'alice').context;
    const oldClose = context.close;
    context.close = async () => { await wait; await oldClose(); };
    const closing = core.close(id, 'alice');
    assert.equal(await core.close(id, 'bob'), false);
    assert.equal(core.activeFor('alice'), 1);
    await assert.rejects(core.create({ url: 'https://example.com/', owner: 'alice' }), /Tenant capacity/);
    const b = await core.create({ url: 'https://example.com/', owner: 'bob' });
    release();
    assert.equal(await closing, true);
    assert.equal(core.activeFor('alice'), 0);
    assert.equal(core.closingOwners.size, 0);
    await core.close(b.id, 'bob');
  } finally { release(); await core.stop(); }
});


test('tenant stream authorization is enforced before CDP allocation', async () => {
  const { core } = makeCore();
  await core.start();
  try {
    const { id } = await core.create({ url: 'https://example.com/', owner: 'alice' });
    let allocations = 0;
    core.get(id, 'alice').context.newCDPSession = async () => {
      allocations++;
      const cdp = new EventEmitter();
      cdp.send = async () => {};
      cdp.detach = async () => {};
      return cdp;
    };
    await assert.rejects(core.stream(id, () => {}, {}, 'bob'), /not found/i);
    assert.equal(allocations, 0);
    const stop = await core.stream(id, () => {}, {}, 'alice');
    assert.equal(allocations, 1);
    await stop();
    assert.equal(core.get(id, 'alice').stream, null);
  } finally { await core.stop(); }
});
