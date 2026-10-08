import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCore } from '../src/core.js';
import { createPreviewServer } from '../src/http.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function withCore({ screenshot, config = {} }, run) {
  const core = new PreviewCore({
    config: { maxScreenshotBytes: 32, ...config },
    validate: async url => url,
    browserFactory: async () => ({
      newContext: async () => ({
        route: async () => {},
        newPage: async () => ({
          goto: async () => null,
          url: () => 'https://example.com/',
          viewportSize: () => ({ width: 390, height: 640 }),
          screenshot
        }),
        close: async () => {}
      }),
      close: async () => {}
    })
  });
  await core.start();
  try {
    const { id } = await core.create({ url: 'https://example.com/', owner: 'alice' });
    await run(core, id);
  } finally { await core.stop(); }
}

test('screenshot bytes must fit the configured output ceiling', async () => {
  await withCore({ screenshot: async () => Buffer.alloc(33) }, async (core, id) => {
    await assert.rejects(core.screenshot(id, 'alice'), /Screenshot size limit exceeded/);
    assert.equal(core.sessions.size, 1);
  });
  await withCore({ screenshot: async () => Buffer.alloc(32) }, async (core, id) => {
    assert.equal((await core.screenshot(id, 'alice')).byteLength, 32);
  });
});

test('concurrent capture on one session is rejected and reservation is released', async () => {
  const gate = deferred();
  let calls = 0;
  await withCore({ screenshot: async () => { calls++; await gate.promise; return Buffer.alloc(4); } }, async (core, id) => {
    const first = core.screenshot(id, 'alice');
    try {
      await assert.rejects(core.screenshot(id, 'alice'), /Screenshot already active/);
      assert.equal(calls, 1);
    } finally { gate.resolve(); }
    await first;
    await core.screenshot(id, 'alice');
    assert.equal(calls, 2);
  });
});

test('a capture cannot return image data after its session is removed', async () => {
  const gate = deferred();
  await withCore({ screenshot: async () => { await gate.promise; return Buffer.alloc(4); } }, async (core, id) => {
    const shot = core.screenshot(id, 'alice');
    await core.close(id, 'alice');
    gate.resolve();
    await assert.rejects(shot, /Session not found/);
    assert.equal(core.sessions.size, 0);
  });
});

test('invalid screenshot output configuration fails closed', () => {
  for (const maxScreenshotBytes of [0, -1, 1.5, NaN, Infinity, 65 * 1024 * 1024]) {
    assert.throws(() => new PreviewCore({ config: { maxScreenshotBytes } }), /Invalid screenshot size limit/);
  }
});

test('HTTP screenshot over budget returns 413 without returning the image', async () => {
  await withCore({ screenshot: async () => Buffer.alloc(33) }, async (core, id) => {
    const secret = 'screenshot-test-secret-of-sufficient-length';
    const server = createPreviewServer(core, { tenants: { alice: secret } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/sessions/${id}/screenshot`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(response.status, 413);
      assert.match((await response.json()).error, /Screenshot size limit exceeded/);
      assert.equal(core.get(id, 'alice').screenshotPending, false);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
