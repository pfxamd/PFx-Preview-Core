import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as connectTCP } from 'node:net';
import { existsSync } from 'node:fs';
import { PreviewCore } from '../src/core.js';
import { GuardedEgressProxy } from '../src/egress.js';

const liveTest = (process.env.PFX_RUN_BROWSER === '1' || (process.env.PFX_CHROMIUM_PATH && existsSync(process.env.PFX_CHROMIUM_PATH))) ? test : test.skip;
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }

liveTest('Chromium navigation is actually routed through pinned egress proxy', { timeout: 30_000 }, async t => {
  let visits = 0; let pinnedAddress = '';
  const target = createServer((req, res) => { visits++; res.end('<!doctype html><title>Proxied fixture</title><h1>Verified proxy</h1>'); });
  const port = await listen(target);
  const core = new PreviewCore({
    validate: async url => url,
    egressFactory: () => new GuardedEgressProxy({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      dial: args => { pinnedAddress = args.host; return connectTCP({ host: '127.0.0.1', port }); }
    })
  });
  try {
    await core.start();
    let created;
    try { created = await core.create({ url: 'http://preview.example/' }); }
    catch (e) { if (String(e).includes('ERR_BLOCKED_BY_ADMINISTRATOR') && process.env.PFX_REQUIRE_BROWSER_NETWORK !== '1') { t.skip('Chromium networking restricted by execution environment'); return; } throw e; }
    assert.equal(visits, 1);
    assert.equal(pinnedAddress, '8.8.8.8');
    assert.equal(await core.get(created.id).page.title(), 'Proxied fixture');
    await core.close(created.id);
  } finally { await core.stop(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
});

liveTest('Chromium redirect to loopback never contacts internal service', { timeout: 30_000 }, async t => {
  let internalHits = 0;
  const internal = createServer((_req, res) => { internalHits++; res.end('SECURITY_BREACH'); });
  const internalPort = await listen(internal);
  let publicHits = 0;
  const publicFixture = createServer((_req, res) => { publicHits++; res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/private` }); res.end(); });
  const publicPort = await listen(publicFixture);
  const core = new PreviewCore({
    validate: async url => url,
    egressFactory: () => new GuardedEgressProxy({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      dial: () => connectTCP({ host: '127.0.0.1', port: publicPort })
    })
  });
  try {
    await core.start();
    await assert.rejects(core.create({ url: 'http://preview.example/' }));
    if (publicHits === 0) {
      if (process.env.PFX_REQUIRE_BROWSER_NETWORK === '1') assert.fail('Chromium did not reach public fixture through proxy');
      t.skip('No public fixture navigation: browser networking blocked'); return;
    }
    assert.equal(internalHits, 0);
    assert.equal(core.sessions.size, 0);
  } finally {
    await core.stop(); internal.closeAllConnections(); publicFixture.closeAllConnections();
    await Promise.all([new Promise(r => internal.close(r)), new Promise(r => publicFixture.close(r))]);
  }
});
