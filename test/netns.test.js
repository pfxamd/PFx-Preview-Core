import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { HostBridge } from '../src/host-bridge.js';

const linux = process.platform === 'linux' && spawnSync('unshare', ['--user', '--map-root-user', '--net', '--', 'true']).status === 0;

test('network namespace contains no external routes', { skip: !linux }, () => {
  const text = execFileSync('unshare', ['--user', '--map-root-user', '--net', '--', 'ip', 'route'], { encoding: 'utf8' });
  assert.equal(text.trim(), '');
});

test('host bridge binds private unix socket and relays to vetted proxy', async () => {
  const mock = createServer(socket => socket.on('data', data => socket.write(data)));
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const bridge = new HostBridge(`http://127.0.0.1:${mock.address().port}`);
  await bridge.start();
  try {
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(bridge.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(bridge.path)).mode & 0o777, 0o600);
    const { connect } = await import('node:net');
    const data = await new Promise((resolve, reject) => {
      const client = connect({ path: bridge.path }, () => client.write('pfx-bridge'));
      client.once('data', data => { resolve(data.toString()); client.destroy(); });
      client.once('error', reject);
    });
    assert.equal(data, 'pfx-bridge');
  } finally {
    await bridge.stop();
    await new Promise(resolve => mock.close(resolve));
  }
});

test('isolated namespace has no direct host or internet path, but can reach guarded UNIX bridge', { skip: !linux, timeout: 15_000 }, async () => {
  const mock = createServer(socket => socket.on('data', data => socket.write(data)));
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const bridge = await new HostBridge(`http://127.0.0.1:${mock.address().port}`).start();
  try {
    const probeScript = `
      import { connect } from 'node:net';
      import { execFileSync } from 'node:child_process';
      execFileSync('/usr/sbin/ip', ['link','set','lo','up']);
      const probe = options => new Promise(resolve => {
        const socket = connect(options);
        socket.setTimeout(800);
        socket.on('connect', () => { socket.end(); resolve(true); });
        socket.on('error', () => resolve(false));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
      });
      const local = await probe({host:'127.0.0.1',port:Number(process.argv[1])});
      const external = await probe({host:'8.8.8.8',port:443});
      const unix = await probe({path:process.argv[2]});
      console.log(JSON.stringify({local,external,unix}));
    `;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('unshare', [
      '--user','--map-root-user','--net','--',process.execPath,'--input-type=module','-e',probeScript,
      String(mock.address().port),bridge.path
    ], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout.trim()), { local: false, external: false, unix: true });
  } finally {
    await bridge.stop();
    await new Promise(resolve => mock.close(resolve));
  }
});

test('network namespace is mandatory in hardened CI', () => {
  if (process.env.PFX_REQUIRE_NETNS === '1') assert.ok(linux, 'Linux user+network namespace unavailable');
  else assert.ok(true);
});
