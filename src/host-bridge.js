import { createServer, connect } from 'node:net';
import { mkdtemp, chmod, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Host-side UNIX socket bridge. Only the guarded proxy is reachable across
// the network-namespace boundary; no host TCP ports or routes are shared.
export class HostBridge {
  constructor(proxyUrl) {
    const url = new URL(proxyUrl);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Bridge requires a loopback proxy');
    this.proxyPort = Number(url.port);
    this.clients = new Set();
    this.server = createServer(local => {
      const upstream = connect({ host: '127.0.0.1', port: this.proxyPort });
      for (const socket of [local, upstream]) {
        this.clients.add(socket);
        socket.on('error', () => { local.destroy(); upstream.destroy(); });
        socket.once('close', () => this.clients.delete(socket));
        socket.setTimeout(120_000, () => socket.destroy());
      }
      local.pipe(upstream); upstream.pipe(local);
    });
  }
  async start() {
    this.dir = await mkdtemp(join(tmpdir(), 'pfx-core-'));
    await chmod(this.dir, 0o700);
    this.path = join(this.dir, 'egress.sock');
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.path, () => { this.server.off('error', reject); resolve(); });
      });
      await chmod(this.path, 0o600);
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    for (const socket of this.clients) socket.destroy();
    if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
    if (this.path) await unlink(this.path).catch(() => {});
    if (this.dir) await rmdir(this.dir).catch(() => {});
  }
}
