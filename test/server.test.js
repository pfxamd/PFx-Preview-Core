import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPreviewServer } from '../src/http.js';
import { PreviewCore } from '../src/core.js';
const token = 'test-secret-token-strong-enough-123';

function fakeFactory() {
  const page = {
    goto: async () => {}, url: () => 'https://example.com/', viewportSize: () => ({ width: 390, height: 844 }),
    setViewportSize: async () => {}, screenshot: async () => Buffer.from('PNG'),
    keyboard: { insertText: async () => {}, press: async () => {} },
    mouse: { click: async () => {}, wheel: async () => {} }
  };
  return async () => ({
    newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }),
    close: async () => {}
  });
}

async function startServer() {
  const core = new PreviewCore({ browserFactory: fakeFactory(), validate: async u => u });
  await core.start();
  const server = createPreviewServer(core, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { core, server, base: `http://127.0.0.1:${server.address().port}` };
}
const opts = (method = 'GET', body = undefined) => ({ method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('server requires bearer token and denies browser cross-origin requests', async () => {
  const { core, server, base } = await startServer();
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/sessions`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/sessions`, { ...opts('POST', { url: 'https://example.com' }), headers: { ...opts().headers, origin: 'https://evil.example' } })).status, 403);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await core.stop(); }
});

test('HTTP lifecycle: create, resize, input, screenshot and close', async () => {
  const { core, server, base } = await startServer();
  try {
    const created = await fetch(`${base}/sessions`, opts('POST', { url: 'https://example.com', width: 390, height: 844 }));
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.ok(id);
    assert.equal((await fetch(`${base}/sessions/${id}/resize`, opts('POST', { width: 500, height: 800 }))).status, 200);
    assert.equal((await fetch(`${base}/sessions/${id}/input`, opts('POST', { kind: 'click', x: 25, y: 50 }))).status, 200);
    const png = await fetch(`${base}/sessions/${id}/screenshot`, opts());
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/sessions/${id}`, opts('DELETE'))).status, 200);
    assert.equal(core.sessions.size, 0);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await core.stop(); }
});

test('HTTP stream sends SSE frames and closes on client disconnect', async () => {
  const { core, server, base } = await startServer();
  let cleaned = false;
  const id = randomUUID();
  core.sessions.set(id, { stream: null, touched: Date.now() });
  const oldStream = core.stream.bind(core);
  core.stream = async (_id, onFrame) => {
    const close = async () => { cleaned = true; core.sessions.get(id).stream = null; };
    core.sessions.get(id).stream = close;
    queueMicrotask(() => onFrame({ mime: 'image/jpeg', data: 'ZmFrZQ==', metadata: {} }));
    return close;
  };
  try {
    const controller = new AbortController();
    const response = await fetch(`${base}/sessions/${id}/stream`, { ...opts(), signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    let text = '';
    for (let i = 0; i < 5 && !text.includes('ZmFrZQ=='); i++) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /event: frame/);
    assert.match(text, /ZmFrZQ==/);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(cleaned, true);
  } finally {
    core.stream = oldStream;
    core.sessions.delete(id);
    server.closeAllConnections(); await new Promise(r => server.close(r)); await core.stop();
  }
});

const chromiumPath = process.env.PFX_CHROMIUM_PATH;
test('end-to-end HTTP SSE delivers actual Chromium CDP frames', {
  skip: !(chromiumPath || process.env.PFX_RUN_BROWSER === '1'), timeout: 30_000
}, async () => {
  const core = new PreviewCore();
  await core.start();
  const server = createPreviewServer(core, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const context = await core.browser.newContext({ viewport: { width: 600, height: 700 } });
    const page = await context.newPage();
    await page.setContent('<!doctype html><div id="changing" style="background:red;height:300px">Live SSE</div>');
    const id = randomUUID();
    core.sessions.set(id, { page, context, touched: Date.now(), stream: null });
    const abort = new AbortController();
    const response = await fetch(`${base}/sessions/${id}/stream`, { ...opts(), signal: abort.signal });
    assert.equal(response.status, 200);
    const changes = (async () => {
      for (let i = 0; i < 8; i++) {
        await page.locator('#changing').evaluate((el, index) => { el.style.background = index % 2 ? 'blue' : 'green'; }, i);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('event: frame')) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /"mime":"image\/jpeg"/);
    await changes;
    abort.abort();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(core.get(id).stream, null);
    await core.close(id);
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r)); await core.stop();
  }
});
