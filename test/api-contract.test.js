// Pinned wire contract for PFx Responsive. Do not change these responses
// without explicitly versioning the client/server API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../src/http.js';
import { PreviewCore } from '../src/core.js';

const keys = {
  designer: 'contract-designer-secret-1234567890',
  reviewer: 'contract-reviewer-secret-1234567890'
};
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const headers = secret => ({ authorization: `Bearer ${secret}`, 'content-type': 'application/json' });
const api = (secret, method = 'GET', body) => ({
  method, headers: headers(secret), ...(body !== undefined ? { body: JSON.stringify(body) } : {})
});

async function fixture(run, config = {}) {
  const events = [];
  const core = new PreviewCore({
    config: { maxSessions: 3, maxSessionsPerOwner: 2, ...config },
    validate: async url => url,
    browserFactory: async () => ({
      newContext: async ({ viewport }) => {
        let current = { ...viewport };
        let currentUrl = 'https://example.org/';
        const page = {
          goto: async url => {
            currentUrl = url;
            return { status: () => 200, headerValue: async () => null };
          },
          url: () => currentUrl,
          viewportSize: () => current,
          setViewportSize: async size => { current = { ...size }; },
          screenshot: async () => pngBytes,
          mouse: { click: async (x, y) => events.push(['click', x, y]), wheel: async (x, y) => events.push(['scroll', x, y]) },
          keyboard: { insertText: async text => events.push(['type', text]), press: async key => events.push(['key', key]) }
        };
        return { newPage: async () => page, route: async () => {}, close: async () => {} };
      }, close: async () => {}
    })
  });
  await core.start();
  const server = createPreviewServer(core, { tenants: keys, allowedOrigin: 'https://localhost-ui.example' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try { await run({ root, core, events }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await core.stop();
  }
}

const createBody = { url: 'https://example.org/', width: 390, height: 640 };

test('API contract: health, authorization and security response headers', async () => {
  await fixture(async ({ root }) => {
    const health = await fetch(`${root}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    const denied = await fetch(`${root}/sessions`, { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'Unauthorized' });
    const forbidden = await fetch(`${root}/sessions`, { ...api(keys.designer, 'POST', createBody), headers: { ...headers(keys.designer), origin: 'https://evil.example' } });
    assert.equal(forbidden.status, 403);
    const preflight = await fetch(`${root}/sessions`, { method: 'OPTIONS', headers: { origin: 'https://localhost-ui.example' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost-ui.example');
  });
});

test('API contract: create, resize, input, navigate, PNG and close have stable wire shapes', async () => {
  await fixture(async ({ root, events }) => {
    const created = await fetch(`${root}/sessions`, api(keys.designer, 'POST', createBody));
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.deepEqual(Object.keys(body).sort(), ['httpStatus', 'id', 'url', 'viewport']);
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.httpStatus, 200);
    assert.equal(body.url, createBody.url);
    assert.deepEqual(body.viewport, { width: 390, height: 640 });
    assert.equal((await fetch(`${root}/sessions/${body.id}/resize`, api(keys.designer, 'POST', { width: 768, height: 960 }))).status, 200);
    const resized = await fetch(`${root}/sessions/${body.id}/resize`, api(keys.designer, 'POST', { width: 800, height: 1000 }));
    assert.deepEqual(await resized.json(), { viewport: { width: 800, height: 1000 } });
    const input = await fetch(`${root}/sessions/${body.id}/input`, api(keys.designer, 'POST', { kind: 'click', x: 22, y: 33 }));
    assert.equal(input.status, 200);
    assert.deepEqual(await input.json(), { accepted: true });
    assert.deepEqual(events, [['click', 22, 33]]);
    const navigated = await fetch(`${root}/sessions/${body.id}/navigate`, api(keys.designer, 'POST', { url: 'https://example.net/page' }));
    assert.equal(navigated.status, 200);
    assert.deepEqual(await navigated.json(), { url: 'https://example.net/page', httpStatus: 200 });
    const screenshot = await fetch(`${root}/sessions/${body.id}/screenshot`, api(keys.designer));
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), pngBytes);
    const closed = await fetch(`${root}/sessions/${body.id}`, api(keys.designer, 'DELETE'));
    assert.deepEqual(await closed.json(), { closed: true });
    const again = await fetch(`${root}/sessions/${body.id}`, api(keys.designer, 'DELETE'));
    assert.deepEqual(await again.json(), { closed: false });
  });
});

test('API contract: foreign tenant sees 404 on all readable/control endpoints', async () => {
  await fixture(async ({ root }) => {
    const create = await fetch(`${root}/sessions`, api(keys.designer, 'POST', { ...createBody, owner: 'reviewer' }));
    assert.equal(create.status, 201);
    const { id } = await create.json();
    const unauthorizedActions = [
      ['GET', 'screenshot'], ['GET', 'stream'],
      ['POST', 'resize', { width: 500, height: 500 }],
      ['POST', 'input', { kind: 'click', x: 10, y: 10 }],
      ['POST', 'navigate', { url: 'https://example.com/' }]
    ];
    for (const [method, path, body] of unauthorizedActions) {
      const response = await fetch(`${root}/sessions/${id}/${path}`, api(keys.reviewer, method, body));
      assert.equal(response.status, 404, `leaked ownership on ${path}`);
      assert.deepEqual(await response.json(), { error: 'Session not found' });
    }
    const deleted = await fetch(`${root}/sessions/${id}`, api(keys.reviewer, 'DELETE'));
    assert.deepEqual(await deleted.json(), { closed: false });
    const exists = await fetch(`${root}/sessions/${id}/screenshot`, api(keys.designer));
    assert.equal(exists.status, 200);
    await fetch(`${root}/sessions/${id}`, api(keys.designer, 'DELETE'));
  });
});

test('API contract: malformed requests are 400, missing routes 404, exhausted quotas 409, offline core 503', async () => {
  await fixture(async ({ root, core }) => {
    const badBody = await fetch(`${root}/sessions`, api(keys.designer, 'POST', [1, 2]));
    assert.equal(badBody.status, 400);
    assert.match((await badBody.json()).error, /Expected JSON object/);
    const missing = await fetch(`${root}/api/v2/sessions`, api(keys.designer));
    assert.equal(missing.status, 404);
    const created = await fetch(`${root}/sessions`, api(keys.designer, 'POST', createBody));
    const { id } = await created.json();
    const second = await fetch(`${root}/sessions`, api(keys.designer, 'POST', createBody));
    assert.equal(second.status, 201);
    const denied = await fetch(`${root}/sessions`, api(keys.designer, 'POST', createBody));
    assert.equal(denied.status, 409);
    assert.match((await denied.json()).error, /capacity/i);
    const oversized = await fetch(`${root}/sessions/${id}/input`, {
      method: 'POST', headers: headers(keys.designer), body: JSON.stringify({ kind: 'type', text: 'A'.repeat(40_000) })
    });
    assert.equal(oversized.status, 413);
    await core.stop();
    const unavailable = await fetch(`${root}/sessions`, api(keys.designer, 'POST', createBody));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'Core is not accepting sessions' });
  });
});
