// Functional Windows-only smoke: not an adversarial browser sandbox test.
import assert from 'node:assert/strict';
import { PreviewCore } from '../src/core.js';

if (process.platform !== 'win32') throw new Error('Windows smoke test requires Windows');
if (process.env.PFX_LOCAL_WINDOWS !== '1') throw new Error('Opt-in Windows local mode explicitly required');
const core = new PreviewCore();
try {
  await core.start();
  const created = await core.create({url:'https://example.com/',width:390,height:844});
  assert.ok(created.id);
  assert.equal(created.viewport.width,390);
  const png = await core.screenshot(created.id);
  assert.deepEqual([...png.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.ok(png.byteLength>1000);
  await core.resize(created.id,{width:420,height:820});
  assert.equal(await core.close(created.id),true);
  assert.equal(core.sessions.size,0);
  console.log(JSON.stringify({status:'PASS',platform:'win32',browser:'chromium',screenshots:1,bytes:png.byteLength,remainingSessions:core.sessions.size}));
} finally {await core.stop();}
