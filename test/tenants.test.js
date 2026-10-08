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

test('per-tenant pixel quota limits concurrent pending creations without starving other tenants', async () => {
  const { core } = makeCore({ maxSessions: 4, maxSessionsPerOwner: 3, maxPixelsPerOwner: 500_000 });
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const originalValidate = core.validate;
  core.validate = async url => { await gate; return originalValidate(url); };
  await core.start();
  try {
    const first = core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' });
    const second = core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' });
    assert.equal(core.allocatedPixelsFor('alice'), 499_200);
    await assert.rejects(core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' }), /Tenant pixel budget/);
    const third = core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'bob' });
    assert.equal(core.allocatedPixelsFor('bob'), 249_600);
    unblock();
    const ids = await Promise.all([first, second, third]);
    assert.equal(core.allocatedPixelsFor('alice'), 499_200);
    await Promise.all(ids.map((session, i) => core.close(session.id, i === 2 ? 'bob' : 'alice')));
    assert.equal(core.allocatedPixelsFor('alice'), 0);
    assert.equal(core.allocatedPixelsFor('bob'), 0);
  } finally { unblock(); await core.stop(); }
});

test('tenant pixel quota applies to resize, preserving previous reservations after refusal', async () => {
  const { core } = makeCore({ maxSessions: 4, maxSessionsPerOwner: 3, maxPixelsPerOwner: 600_000 });
  await core.start();
  try {
    const first = await core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' });
    const second = await core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' });
    await assert.rejects(core.resize(first.id, { width: 650, height: 650 }, 'alice'), /Tenant pixel budget/);
    assert.equal(core.allocatedPixelsFor('alice'), 499_200);
    const bob = await core.create({ url: 'https://example.com/', width: 650, height: 650, owner: 'bob' });
    assert.equal(core.allocatedPixelsFor('bob'), 422_500);
    assert.deepEqual(await core.resize(first.id, { width: 500, height: 600 }, 'alice'), { viewport: { width: 390, height: 640 } });
    assert.equal(core.allocatedPixelsFor('alice'), 549_600);
    await Promise.all([core.close(first.id, 'alice'), core.close(second.id, 'alice'), core.close(bob.id, 'bob')]);
    assert.equal(core.allocatedPixelsFor('alice'), 0);
  } finally { await core.stop(); }
});

test('tenant pixel reservations stay charged until asynchronous context close finishes', async () => {
  const { core } = makeCore({ maxSessions: 3, maxSessionsPerOwner: 2, maxPixelsPerOwner: 250_000 });
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  await core.start();
  try {
    const { id } = await core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' });
    const session = core.get(id, 'alice');
    const closeContext = session.context.close;
    session.context.close = async () => { await gate; await closeContext(); };
    const closing = core.close(id, 'alice');
    assert.equal(core.allocatedPixelsFor('alice'), 249_600);
    await assert.rejects(core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'alice' }), /Tenant pixel budget/);
    const other = await core.create({ url: 'https://example.com/', width: 390, height: 640, owner: 'bob' });
    unblock();
    await closing;
    assert.equal(core.allocatedPixelsFor('alice'), 0);
    await core.close(other.id, 'bob');
  } finally { unblock(); await core.stop(); }
});

test('tenant quota configuration rejects invalid or unusable limits', () => {
  for (const maxPixelsPerOwner of [0, -1, 0.5, Infinity, 49_000_000]) {
    assert.throws(() => makeCore({ maxPixelsPerOwner }), /Invalid per-tenant pixel quota/);
  }
});

test('HTTP tenant pixel exhaustion returns 409 and does not affect another tenant', async () => {
  await withServer({ maxSessions: 4, maxSessionsPerOwner: 2, maxPixelsPerOwner: 250_000 }, async ({ base }) => {
    const payload = { url: 'https://example.com/', width: 390, height: 640 };
    const first = await fetch(`${base}/sessions`, options(alice, 'POST', payload));
    assert.equal(first.status, 201);
    const { id } = await first.json();
    const second = await fetch(`${base}/sessions`, options(alice, 'POST', payload));
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /Tenant pixel budget/);
    const bobFirst = await fetch(`${base}/sessions`, options(bob, 'POST', payload));
    assert.equal(bobFirst.status, 201);
    const { id: bobId } = await bobFirst.json();
    const aliceResize = await fetch(`${base}/sessions/${id}/resize`, options(alice, 'POST', { width: 600, height: 600 }));
    assert.equal(aliceResize.status, 409);
    assert.equal((await fetch(`${base}/sessions/${bobId}/screenshot`, options(bob))).status, 200);
    await fetch(`${base}/sessions/${id}`, options(alice, 'DELETE'));
    await fetch(`${base}/sessions/${bobId}`, options(bob, 'DELETE'));
  });
});
