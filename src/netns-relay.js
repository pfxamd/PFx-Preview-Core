import { createServer, connect as connectTCP } from 'node:net';
import { spawn } from 'node:child_process';

// Browser worker. It runs after unshare has removed ALL network routes.
// A single fixed loopback listener bridges browser requests to a UNIX socket
// owned by the host. The host side enforces public-IP policy.
const socketPath = process.env.PFX_HOST_PROXY_SOCKET;
const browserPath = process.env.PFX_REAL_CHROMIUM;
const port = 34177;
if (!socketPath || !browserPath) throw new Error('Missing isolated worker configuration');
// Loopback was enabled by sandbox-bootstrap before chroot.
const outgoing = new Set();
const relay = createServer(client => {
  const host = connectTCP({ path: socketPath });
  outgoing.add(client); outgoing.add(host);
  for (const connection of [client, host]) {
    connection.on('error', () => { client.destroy(); host.destroy(); });
    connection.on('close', () => outgoing.delete(connection));
    connection.setTimeout(120_000, () => connection.destroy());
  }
  client.pipe(host); host.pipe(client);
});
relay.listen(port, '127.0.0.1', () => {
  const chrome = spawn('/usr/bin/setpriv', [
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
    '--', '/usr/bin/prlimit', '--nofile=4096:4096', '--fsize=67108864:67108864',
    '--core=0:0', '--cpu=180:180', '--', browserPath, ...process.argv.slice(2)
  ], {
    stdio: ['ignore', 'inherit', 'inherit', 3, 4],
    // Never expose server tokens or cloud credentials to a compromised browser.
    env: Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']
      .filter(name => typeof process.env[name] === 'string')
      .map(name => [name, process.env[name]]))
  });
  const exit = (code, signal) => {
    for (const socket of outgoing) socket.destroy();
    relay.close(() => process.exit(typeof code === 'number' ? code : 1));
  };
  chrome.once('error', err => { console.error(err); exit(1); });
  chrome.once('exit', exit);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => chrome.kill(signal));
});
