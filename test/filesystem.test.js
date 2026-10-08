import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../src/sandbox-bootstrap.sh', import.meta.url));
const probe = fileURLToPath(new URL('./fixtures/fs-probe.js', import.meta.url));
const runner = spawnSync('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--ipc', '--uts', '--fork', '--', 'true']);
const linuxNamespaces = process.platform === 'linux' && runner.status === 0;

test('chrooted worker has private mount + process namespace and no host private files', {timeout: 20_000, skip: !linuxNamespaces && process.env.PFX_REQUIRE_FS_SANDBOX !== '1'}, async t => {
  if (!linuxNamespaces) assert.fail('Filesystem namespaces unavailable');
  const root = await mkdtemp(join(tmpdir(), 'pfx-fs-'));
  const bridge = await mkdtemp(join(tmpdir(), 'pfx-probe-'));
  try {
    const child = spawnSync('unshare', [
      '--user', '--map-root-user', '--net', '--mount', '--pid', '--ipc', '--uts', '--fork',
      '--propagation', 'private', '--', '/bin/sh', path
    ], {
      timeout: 15_000, encoding: 'utf8', env: {
        PATH: '/usr/sbin:/usr/bin:/bin', HOME: '/tmp',
        PFX_NODE_BINARY: process.execPath, PFX_NETNS_WORKER: probe,
        PFX_SANDBOX_ROOT: root, PFX_REAL_CHROMIUM: '/usr/bin/true',
        PFX_HOST_PROXY_SOCKET: join(bridge, 'egress.sock')
      }
    });
    if (child.status !== 0) {
      // Restricted containers cannot mount proc in a child PID namespace.
      if (process.env.PFX_REQUIRE_FS_SANDBOX === '1') assert.fail(child.stderr || String(child.error));
      t.skip('OS prohibits the fully isolated filesystem sandbox: ' + (child.stderr || '').slice(-200));
      return;
    }
    const details = JSON.parse(child.stdout.trim());
    assert.equal(details.pid, 1);
    assert.equal(details.hasProcessNamespace, true);
    assert.equal(details.hasHostCredentials, false);
    assert.equal(details.hasOutsideConfiguration, false);
    assert.equal(details.hasGuardedSocketDirectory, true);
    assert.equal(details.hasWorker, true);
    assert.match(details.passwd, /^root:x:0:0:isolated:/);
    assert.deepEqual(details.rootEntries.sort(), ['app','bin','bridge','browser','dev','etc','lib','lib64','node-bin','proc','run','sbin','tmp','usr'].filter(()=>true).sort());
  } finally {
    await rmdir(root).catch(() => {});
    await rmdir(bridge).catch(() => {});
  }
});
