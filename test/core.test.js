import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCore } from '../src/core.js';
import { validateTarget, isDisallowedIP } from '../src/security.js';

const resolver = async () => [{ address: '8.8.8.8' }];
test('rejects invalid or non-web target schemes', async () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'http://user:pass@example.com', 'http://localhost']) await assert.rejects(validateTarget(url, resolver));
});
test('rejects private, loopback, metadata and mixed DNS results', async () => {
  for (const ip of ['127.0.0.1', '10.4.1.2', '192.168.2.1', '172.16.0.1', '169.254.169.254', '::1', 'fc00::1']) assert.equal(isDisallowedIP(ip), true);
  await assert.rejects(validateTarget('https://example.com', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]));
});
test('accepts public target with safe DNS resolution', async () => assert.equal(await validateTarget('https://example.com/path', resolver), 'https://example.com/path'));
function fakeFactory() {
  const state = { closed: 0, viewport: { width: 1280, height: 800 } };
  const page = { goto: async () => {}, url: () => 'https://example.com/', viewportSize: () => state.viewport, setViewportSize: async v => { state.viewport = v; }, screenshot: async () => Buffer.from('PNG') };
  const factory = async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => { state.closed++; } }), close: async () => {} });
  return { factory, state };
}
test('creates, resizes, screenshots and closes isolated session', async () => {
  const { factory, state } = fakeFactory();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  const session = await core.create({ url: 'https://example.com' });
  assert.ok(session.id);
  assert.deepEqual(await core.resize(session.id, { width: 390, height: 844 }), { viewport: { width: 390, height: 844 } });
  assert.equal((await core.screenshot(session.id)).toString(), 'PNG');
  assert.equal(await core.close(session.id), true);
  assert.equal(state.closed, 1);
  await core.stop();
});
test('enforces session capacity and idle cleanup', async () => {
  const { factory } = fakeFactory();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u, config: { maxSessions: 1, idleMs: 10 } });
  await core.start();
  await core.create({ url: 'https://example.com' });
  await assert.rejects(core.create({ url: 'https://example.com' }), /capacity/);
  assert.equal(await core.prune(Date.now() + 100), 1);
  assert.equal(core.sessions.size, 0);
  await core.stop();
});
test('rejects invalid viewports', async () => {
  const { factory } = fakeFactory();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  await assert.rejects(core.create({ url: 'https://example.com', width: -1 }), /Invalid width/);
  await core.stop();
});

test('rejects unsafe subresource and navigation targets through routing guard', async () => {
  let guard;
  let aborted = 0, continued = 0;
  const context = {
    route: async (_pattern, listener) => { guard = listener; },
    newPage: async () => ({ goto: async () => {}, url: () => 'https://example.com', viewportSize: () => ({ width: 400, height: 600 }) }),
    close: async () => {}
  };
  const browserFactory = async () => ({ newContext: async () => context, close: async () => {} });
  const core = new PreviewCore({ browserFactory, validate: async url => { if (url.includes('127.0.0.1')) throw new Error('Destination is not public'); return url; } });
  await core.start();
  const session = await core.create({ url: 'https://example.com' });
  const request = url => ({ request: () => ({ url: () => url }), abort: async () => { aborted++; }, continue: async () => { continued++; } });
  await guard(request('https://example.com/asset.js'));
  await guard(request('http://127.0.0.1:8000/private'));
  assert.equal(continued, 1);
  assert.equal(aborted, 1);
  await assert.rejects(core.navigate(session.id, 'http://127.0.0.1:8000/private'), /not public/);
  await core.stop();
});

test('pending session creations count toward capacity', async () => {
  let proceed;
  const gate = new Promise(resolve => { proceed = resolve; });
  const browserFactory = async () => ({ newContext: async () => ({
    route: async () => {}, newPage: async () => ({ goto: async () => gate, url: () => 'https://example.com', viewportSize: () => ({ width: 400, height: 600 }) }), close: async () => {}
  }), close: async () => {} });
  const core = new PreviewCore({ browserFactory, validate: async u => u, config: { maxSessions: 1 } });
  await core.start();
  const creating = core.create({ url: 'https://example.com' });
  await assert.rejects(core.create({ url: 'https://example.com' }), /capacity/);
  proceed();
  await creating;
  assert.equal(core.pendingCreates, 0);
  await core.stop();
});
