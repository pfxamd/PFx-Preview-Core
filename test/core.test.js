import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCore } from '../src/core.js';
import { validateTarget, isDisallowedIP } from '../src/security.js';
const resolver = async () => [{ address: '8.8.8.8' }];
test('rejects non-web targets', async () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'http://user:pass@example.com', 'http://localhost']) await assert.rejects(validateTarget(url, resolver));
});
test('rejects internal DNS results', async () => {
  for (const ip of ['127.0.0.1', '10.4.1.2', '192.168.2.1', '172.16.0.1', '169.254.169.254', '::1', 'fc00::1']) assert.equal(isDisallowedIP(ip), true);
  await assert.rejects(validateTarget('https://example.com', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]));
});
test('accepts public target', async () => assert.equal(await validateTarget('https://example.com/path', resolver), 'https://example.com/path'));
function fakeFactory() {
  const state = { closed: 0, viewport: { width: 1280, height: 800 } };
  const page = { goto: async () => {}, url: () => 'https://example.com/', viewportSize: () => state.viewport, setViewportSize: async v => { state.viewport = v; }, screenshot: async () => Buffer.from('PNG') };
  const factory = async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => { state.closed++; } }), close: async () => {} });
  return { factory, state };
}
test('creates, resizes, captures, closes', async () => {
  const { factory, state } = fakeFactory();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  const s = await core.create({ url: 'https://example.com' });
  assert.ok(s.id);
  assert.deepEqual(await core.resize(s.id, { width: 390, height: 844 }), { viewport: { width: 390, height: 844 } });
  assert.equal((await core.screenshot(s.id)).toString(), 'PNG');
  assert.equal(await core.close(s.id), true);
  assert.equal(state.closed, 1);
  await core.stop();
});
test('enforces capacity and idle cleanup', async () => {
  const { factory } = fakeFactory();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u, config: { maxSessions: 1, idleMs: 10 } });
  await core.start();
  await core.create({ url: 'https://example.com' });
  await assert.rejects(core.create({ url: 'https://example.com' }), /capacity/);
  assert.equal(await core.prune(Date.now() + 100), 1);
  await core.stop();
});
test('rejects invalid viewports', async () => {
  const { factory } = fakeFactory();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  await assert.rejects(core.create({ url: 'https://example.com', width: -1 }), /Invalid width/);
  await core.stop();
});
