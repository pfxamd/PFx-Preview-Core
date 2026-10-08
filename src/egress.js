import { Agent, createServer as createHTTPServer, request as requestHTTP } from 'node:http';
import { connect as connectTCP, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isDisallowedIP } from './security.js';

// This proxy provides application-layer SSRF resistance only. The Chromium
// process MUST be separately confined by OS/network egress rules for public use.
function normalizedHost(input) {
  if (typeof input !== 'string' || !input || input.length > 253) throw new Error('Invalid hostname');
  const host = input.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host.includes('%') || !host || /[\s\\/@]/.test(host)) throw new Error('Invalid hostname');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' ||
      ['.internal', '.local', '.test', '.invalid'].some(suffix => host.endsWith(suffix))) {
    throw new Error('Destination is not public');
  }
  return host;
}

function parseAuthority(authority) {
  if (typeof authority !== 'string' || authority.length > 300 || /[\\/@?#\s]/.test(authority)) throw new Error('Invalid CONNECT authority');
  const url = new URL(`https://${authority}/`);
  if (url.username || url.password || url.pathname !== '/' || !url.hostname) throw new Error('Invalid CONNECT authority');
  const port = authority.match(/:(\d+)$/)?.[1];
  if (!port || Number(port) !== 443) throw new Error('CONNECT permitted only on 443');
  return { hostname: normalizedHost(url.hostname), port: 443 };
}

const hasBody = method => !['GET', 'HEAD'].includes(method);
const stripHopHeaders = original => {
  const headers = { ...original };
  const named = (headers.connection ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const name of ['proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...named]) delete headers[name];
  return headers;
};

export class GuardedEgressProxy {
  constructor({ resolver = dnsLookup, dial = connectTCP, connectTimeoutMs = 10_000, connectionIdleMs = 120_000, maxSockets = 32, allowAddress = address => !isDisallowedIP(address) } = {}) {
    this.resolver = resolver;
    this.dial = dial;
    this.connectTimeoutMs = connectTimeoutMs;
    this.connectionIdleMs = connectionIdleMs;
    this.maxSockets = maxSockets;
    this.allowAddress = allowAddress;
    this.activeSockets = 0;
    this.connections = new Set();
    this.server = createHTTPServer((req, res) => { void this.onHTTP(req, res); });
    this.server.on('connect', (req, socket, head) => { void this.onConnect(req, socket, head); });
    this.server.on('upgrade', (req, socket, head) => { void this.onUpgrade(req, socket, head); });
    this.server.on('clientError', (_err, socket) => { socket.destroy(); });
    this.server.on('connection', socket => { this.connections.add(socket); socket.once('close', () => this.connections.delete(socket)); });
  }
  get url() {
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Proxy not started');
    return `http://127.0.0.1:${addr.port}`;
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    return this;
  }
  async stop() {
    for (const socket of this.connections) socket.destroy();
    await new Promise(resolve => this.server.close(resolve));
  }
  async resolve(hostname) {
    const host = normalizedHost(hostname);
    if (isIP(host)) {
      if (!this.allowAddress(host)) throw new Error('Destination IP is blocked');
      return { address: host, family: isIP(host) };
    }
    const answers = await this.resolver(host, { all: true, verbatim: true });
    if (!Array.isArray(answers) || answers.length === 0 || answers.some(x => !x || !this.allowAddress(x.address) || ![4, 6].includes(isIP(x.address)))) {
      throw new Error('DNS resolved to a non-public destination');
    }
    // DNS is resolved immediately before connecting. Do not re-resolve the name.
    return answers.find(answer => isIP(answer.address) === 4) ?? answers[0];
  }
  acquire() {
    if (this.activeSockets >= this.maxSockets) throw new Error('Connection limit exceeded');
    this.activeSockets++;
    let released = false;
    return () => { if (!released) { released = true; this.activeSockets--; } };
  }
  async openConnection(hostname, port) {
    const { address, family } = await this.resolve(hostname);
    const release = this.acquire();
    let socket;
    try {
      socket = this.dial({ host: address, family, port, timeout: this.connectTimeoutMs });
      await new Promise((resolve, reject) => {
        const success = () => { cleanup(); resolve(); };
        const fail = error => { cleanup(); reject(error); };
        const timeout = () => { cleanup(); reject(new Error('Connection timed out')); };
        const cleanup = () => { socket.off('connect', success); socket.off('error', fail); socket.off('timeout', timeout); };
        socket.once('connect', success); socket.once('error', fail); socket.once('timeout', timeout);
      });
      socket.setTimeout(this.connectionIdleMs, () => socket.destroy());
      socket.once('close', release);
      return socket;
    } catch (error) { socket?.destroy(); release(); throw error; }
  }
  deny(res, status = 403) {
    if (!res.headersSent) { res.writeHead(status, { connection: 'close', 'content-type': 'text/plain' }); }
    res.end('Blocked by PFx egress policy');
  }
  async onHTTP(req, res) {
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:' || url.username || url.password || (url.port && url.port !== '80')) throw new Error('Not HTTP port 80');
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) throw new Error('Unsupported method');
      const hostname = normalizedHost(url.hostname);
      const socket = await this.openConnection(hostname, 80);
      if (res.destroyed) { socket.destroy(); return; }
      const headers = stripHopHeaders(req.headers);
      headers.host = url.host;
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const upstream = requestHTTP({ agent, host: hostname, port: 80, method: req.method,
        path: `${url.pathname}${url.search}`, headers, timeout: this.connectTimeoutMs }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, { ...stripHopHeaders(upstreamRes.headers), connection: 'close' });
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => this.deny(res, 502));
      upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out')));
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      if (hasBody(req.method)) req.pipe(upstream); else upstream.end();
    } catch { this.deny(res); }
  }
  async onUpgrade(req, client, head) {
    try {
      const url = new URL(req.url);
      if (!['http:', 'ws:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '80') || req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') throw new Error('Unsupported upgrade');
      const hostname = normalizedHost(url.hostname);
      const upstream = await this.openConnection(hostname, 80);
      if (client.destroyed) { upstream.destroy(); return; }
      const headers = stripHopHeaders(req.headers);
      headers.host = url.host;
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade;
      const requestLines = [`GET ${url.pathname}${url.search} HTTP/1.1`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', ''];
      upstream.write(requestLines.join('\r\n'));
      if (head?.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      client.once('error', () => upstream.destroy());
      upstream.once('error', () => client.destroy());
    } catch {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  }
  async onConnect(req, client, head) {
    let target;
    try {
      target = parseAuthority(req.url);
      const upstream = await this.openConnection(target.hostname, target.port);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      client.once('error', () => upstream.destroy());
      upstream.once('error', () => client.destroy());
    } catch {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  }
}
