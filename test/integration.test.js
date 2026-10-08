import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PreviewCore } from '../src/core.js';

const chromePath = process.env.PFX_CHROMIUM_PATH;
const runnable = (chromePath && existsSync(chromePath)) || process.env.PFX_RUN_BROWSER === '1';
const liveTest = runnable ? test : test.skip;

liveTest('real Chromium: renders, clicks, types, resizes and captures PNG', { timeout: 30_000 }, async () => {
  const core = new PreviewCore();
  await core.start();
  try {
    const context = await core.browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head><title>Live preview fixture</title></head><body><input id="field"><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button><h1>Ready</h1></body></html>');
    const id = randomUUID();
    core.sessions.set(id, { context, page, touched: Date.now(), stream: null });
    await page.locator('input').click();
    await core.input(id, { kind: 'type', text: 'Real Chromium' });
    await page.locator('button').click();
    assert.equal(await page.locator('h1').textContent(), 'Real Chromium');
    assert.deepEqual((await core.resize(id, { width: 1280, height: 800 })).viewport, { width: 1280, height: 800 });
    const png = await core.screenshot(id);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length > 1000);
    await core.close(id);
    assert.equal(core.sessions.size, 0);
  } finally { await core.stop(); }
});

liveTest('real Chromium: receives streamed JPEG screencast frames and cleans up', { timeout: 30_000 }, async () => {
  const core = new PreviewCore();
  await core.start();
  try {
    const context = await core.browser.newContext({ viewport: { width: 500, height: 600 } });
    const page = await context.newPage();
    await page.setContent('<!doctype html><div id="changing" style="height:300px;background:red">Frames</div>');
    const id = randomUUID();
    core.sessions.set(id, { context, page, touched: Date.now(), stream: null });
    const frames = [];
    const stop = await core.stream(id, frame => frames.push(frame));
    for (let i = 0; i < 6; i++) {
      await page.locator('#changing').evaluate((el, idx) => { el.style.background = idx % 2 ? 'blue' : 'green'; }, i);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(frames.length >= 2, `Expected 2+ CDP frames, got ${frames.length}`);
    assert.equal(Buffer.from(frames[0].data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
    await stop();
    assert.equal(core.get(id).stream, null);
    await core.close(id);
  } finally { await core.stop(); }
});

liveTest('external website navigation smoke test (opt-in only)', {
  skip: !process.env.PFX_RUN_EXTERNAL, timeout: 40_000
}, async () => {
  const core = new PreviewCore();
  await core.start();
  try {
    const session = await core.create({ url: 'https://example.com/' });
    assert.ok(session.url.startsWith('https://example.com'));
    assert.ok((await core.screenshot(session.id)).length > 1000);
    await core.close(session.id);
  } finally { await core.stop(); }
});

liveTest('real Chromium: separate contexts do not share cookies', { timeout: 30_000 }, async () => {
  const core = new PreviewCore();
  await core.start();
  try {
    const first = await core.browser.newContext();
    const second = await core.browser.newContext();
    await first.addCookies([{ name: 'private', value: 'alice', url: 'https://example.com' }]);
    assert.equal((await first.cookies('https://example.com')).length, 1);
    assert.equal((await second.cookies('https://example.com')).length, 0);
    await first.close(); await second.close();
  } finally { await core.stop(); }
});
