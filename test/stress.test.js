import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PreviewCore } from '../src/core.js';

const realBrowser = Boolean(process.env.PFX_CHROMIUM_PATH || process.env.PFX_RUN_BROWSER === '1');

test('real Chromium: four concurrent isolated viewport streams, 3 lifecycle rounds', {
  skip: !realBrowser, timeout: 60_000
}, async () => {
  const core = new PreviewCore();
  await core.start();
  const widths = [390, 768, 1024, 1440];
  const received = [];
  try {
    for (let round = 0; round < 3; round++) {
      const sessions = await Promise.all(widths.map(async (width, index) => {
        const context = await core.browser.newContext({ viewport: { width, height: 800 } });
        const page = await context.newPage();
        await page.setContent(`<main style="height:350px;background:rgb(${60 + index * 30},20,100)">Session ${index} round ${round}</main>`);
        const id = randomUUID();
        core.sessions.set(id, { context, page, touched: Date.now(), stream: null });
        return { id, page };
      }));
      const frameCounts = [0, 0, 0, 0];
      const closers = await Promise.all(sessions.map(async (session, index) =>
        core.stream(session.id, () => { frameCounts[index]++; })
      ));
      for (let i = 0; i < 4; i++) {
        await Promise.all(sessions.map(({ page }, index) =>
          page.locator('main').evaluate((el, value) => { el.style.background = value % 2 ? 'green' : 'blue'; }, index + i)
        ));
        await new Promise(resolve => setTimeout(resolve, 90));
      }
      received.push(...frameCounts);
      assert.ok(frameCounts.every(n => n > 0), `Round ${round} frame counts: ${frameCounts}`);
      await Promise.all(closers.map(close => close()));
      await Promise.all(sessions.map(session => core.close(session.id)));
      assert.equal(core.sessions.size, 0);
    }
    assert.equal(received.length, 12);
  } finally { await core.stop(); }
});
