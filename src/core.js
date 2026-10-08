import { randomUUID } from 'node:crypto';
import { assertPublicURL, validateTarget } from './security.js';
import { GuardedEgressProxy } from './egress.js';
import { HostBridge } from './host-bridge.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyOSResourceLimits } from './resource-policy.js';

const limits = { maxSessions: 4, idleMs: 10 * 60_000, maxAgeMs: 30 * 60_000,
  navigationMs: 25_000, maxSessionPixels: 12_000_000, maxTotalPixels: 48_000_000 };

export function sanitizedWorkerEnv(from = process.env) {
  // The network-namespace worker must never inherit API tokens, cloud credentials
  // or application secrets, even though the Chrome grandchild uses an allowlist.
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR']
    .filter(name => typeof from[name] === 'string')
    .map(name => [name, from[name]]));
}
const checkViewport = ({ width, height, deviceScaleFactor = 1 }) => {
  for (const [key, n] of Object.entries({ width, height, deviceScaleFactor })) {
    const min = key === 'deviceScaleFactor' ? 1 : 240;
    const max = key === 'deviceScaleFactor' ? 3 : 3840;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  }
};

export class PreviewCore {
  constructor({ browserFactory, validate = validateTarget, egressFactory = () => new GuardedEgressProxy(), config = {} } = {}) {
    this.factory = browserFactory;
    this.customFactory = browserFactory;
    this.validate = validate;
    this.egressFactory = egressFactory;
    this.egress = null;
    this.bridge = null;
    this.sandboxRoot = null;
    this.proxyUrl = null;
    this.config = { ...limits, ...config };
    this.sessions = new Map();
    this.pendingCreates = 0;
    this.pendingOwners = new Map();
    this.closingOwners = new Map();
    this.pendingPixels = 0;
    this.inFlightCreates = new Set();
    this.inFlightCloses = new Map();
    this.closingPixels = 0;
    this.navigationMetadata = new WeakMap();
    this.browser = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.stopping = false;
  }
  async start() {
    if (this.stopPromise) await this.stopPromise;
    if (this.browser) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try { return await this.startPromise; }
    finally { this.startPromise = null; }
  }
  async startInternal() {
    const realBrowser = !this.customFactory;
    if (realBrowser && process.env.PFX_REQUIRE_OS_QUOTAS === '1') await verifyOSResourceLimits();
    if (realBrowser && process.platform !== 'linux') throw new Error('Secure browser runtime currently requires Linux network namespaces');
    this.egress = this.egressFactory();
    try {
      await this.egress.start();
      this.proxyUrl = this.egress.url;
      if (realBrowser) {
        const { chromium } = await import('playwright-core');
        const realPath = process.env.PFX_CHROMIUM_PATH || chromium.executablePath();
        if (!existsSync(realPath)) throw new Error('Chromium binary not installed');
        this.bridge = await new HostBridge(this.egress.url).start();
        this.proxyUrl = 'http://127.0.0.1:34177';
        this.sandboxRoot = await mkdtemp(join(tmpdir(), 'pfx-fs-'));
        this.factory = () => chromium.launch({
          headless: true,
          executablePath: fileURLToPath(new URL('./netns-launcher.sh', import.meta.url)),
          env: {
            ...sanitizedWorkerEnv(),
            PFX_NODE_BINARY: process.execPath,
            PFX_NETNS_WORKER: fileURLToPath(new URL('./netns-relay.js', import.meta.url)),
            PFX_SANDBOX_BOOTSTRAP: fileURLToPath(new URL('./sandbox-bootstrap.sh', import.meta.url)),
            PFX_SANDBOX_ROOT: this.sandboxRoot,
            PFX_REAL_CHROMIUM: realPath,
            PFX_HOST_PROXY_SOCKET: this.bridge.path
          },
          args: [
            '--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-background-networking',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
          ]
        });
      }
      this.browser = await this.factory();
      this.browser.on?.('disconnected', () => {
        // A browser crash must not leave stale sessions and streams available.
        if (!this.stopping) void this.stop().catch(() => {});
      });
      return this;
    } catch (error) {
      if (this.bridge) await this.bridge.stop().catch(() => {});
      this.bridge = null;
      if (this.sandboxRoot) await rmdir(this.sandboxRoot).catch(() => {});
      this.sandboxRoot = null;
      await this.egress.stop().catch(() => {});
      this.egress = null;
      this.proxyUrl = null;
      this.factory = this.customFactory;
      throw error;
    }
  }
  activeFor(owner) {
    let n = this.pendingOwners.get(owner) || 0;
    for (const session of this.sessions.values()) if ((session.owner ?? null) === owner) n++;
    for (const closingOwner of this.closingOwners.values()) if (closingOwner === owner) n++;
    return n;
  }
  create({ url, width = 1280, height = 800, deviceScaleFactor = 1, owner = null } = {}) {
    if (!this.browser || this.stopping) return Promise.reject(new Error('Core is not accepting sessions'));
    if (owner !== null && (typeof owner !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(owner))) return Promise.reject(new Error('Invalid owner'));
    try { checkViewport({ width, height, deviceScaleFactor }); }
    catch (error) { return Promise.reject(error); }
    if (this.sessions.size + this.pendingCreates + this.inFlightCloses.size >= this.config.maxSessions) return Promise.reject(new Error('Session capacity reached'));
    if (this.activeFor(owner) >= (this.config.maxSessionsPerOwner ?? this.config.maxSessions)) return Promise.reject(new Error('Tenant capacity reached'));
    const pixels = width * height * deviceScaleFactor ** 2;
    if (pixels > this.config.maxSessionPixels || this.allocatedPixels() + pixels > this.config.maxTotalPixels) {
      return Promise.reject(new Error('Rendering pixel budget exceeded'));
    }
    this.pendingCreates++;
    this.pendingOwners.set(owner, (this.pendingOwners.get(owner) || 0) + 1);
    this.pendingPixels += pixels;
    const creation = this.createInternal({ url, width, height, deviceScaleFactor, pixels, owner });
    this.inFlightCreates.add(creation);
    void creation.finally(() => this.inFlightCreates.delete(creation)).catch(() => {});
    return creation;
  }
  allocatedPixels() {
    return this.pendingPixels + this.closingPixels + [...this.sessions.values()].reduce((sum, s) => sum + (s.pixels || 0), 0);
  }
  async createInternal({ url, width, height, deviceScaleFactor, pixels, owner }) {
    let context;
    try {
      const target = await this.validate(url);
      context = await this.browser.newContext({
        viewport: { width, height }, deviceScaleFactor, serviceWorkers: 'block', acceptDownloads: false,
        permissions: [],
        proxy: { server: this.proxyUrl, bypass: '<-loopback>' }
      });
      // Defense in depth only: request routing cannot pin DNS or enforce network isolation.
      await context.route('**/*', async route => {
        try { await this.validate(route.request().url()); await route.continue(); }
        catch { await route.abort('blockedbyclient').catch(() => {}); }
      });
      const page = await context.newPage();
      await this.loadPage(page, target);
      if (this.stopping) throw new Error('Core is shutting down');
      const id = randomUUID();
      const result = { id, url: page.url(), viewport: page.viewportSize(),
        httpStatus: this.navigationMetadata.get(page)?.httpStatus ?? null };
      this.sessions.set(id, { context, page, touched: Date.now(), createdAt: Date.now(), pixels, deviceScaleFactor, stream: null, owner });
      context = null;
      return result;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      throw error;
    } finally {
      this.pendingCreates--;
      const remaining = (this.pendingOwners.get(owner) || 1) - 1;
      if (remaining) this.pendingOwners.set(owner, remaining);
      else this.pendingOwners.delete(owner);
      this.pendingPixels -= pixels;
    }
  }
  get(id, owner = null) {
    const session = this.sessions.get(id);
    if (!session || (session.owner ?? null) !== owner) throw new Error('Session not found');
    session.touched = Date.now();
    return session;
  }
  async resize(id, dimensions, owner = null) {
    checkViewport({ ...dimensions, deviceScaleFactor: 1 });
    const session = this.get(id, owner);
    const previous = session.resizing || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const pixels = dimensions.width * dimensions.height * (session.deviceScaleFactor || 1) ** 2;
      if (pixels > this.config.maxSessionPixels || this.allocatedPixels() - (session.pixels || 0) + pixels > this.config.maxTotalPixels) {
        throw new Error('Rendering pixel budget exceeded');
      }
      const prior = session.pixels || 0;
      session.pixels = pixels; // Reserve synchronously before async resize.
      try {
        await session.page.setViewportSize({ width: dimensions.width, height: dimensions.height });
        return { viewport: session.page.viewportSize() };
      } catch (error) { session.pixels = prior; throw error; }
    });
    session.resizing = operation;
    try { return await operation; }
    finally { if (session.resizing === operation) session.resizing = null; }
  }
  async loadPage(page, target) {
    // A redirected main-frame response may be an HTTP 403 generated by the
    // egress proxy, not a Playwright navigation error. Never report it as a
    // successfully opened external website.
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.config.navigationMs });
    const finalUrl = page.url();
    assertPublicURL(finalUrl); // Independent of injectable validator; rejects loopback redirects.
    if (new URL(finalUrl).href !== new URL(target).href) await this.validate(finalUrl);
    if (response?.headerValue && await response.headerValue('x-pfx-egress-blocked') === '1') {
      throw new Error('Navigation blocked by network policy');
    }
    this.navigationMetadata.set(page, {
      httpStatus: typeof response?.status === 'function' ? response.status() : null
    });
    return finalUrl;
  }
  async navigate(id, url, owner = null) {
    // Authorization precedes DNS resolution and any outbound navigation work.
    const session = this.get(id, owner);
    const safeUrl = await this.validate(url);
    const loadedUrl = await this.loadPage(session.page, safeUrl);
    return { url: loadedUrl, httpStatus: this.navigationMetadata.get(session.page)?.httpStatus ?? null };
  }
  async input(id, event, owner = null) {
    if (!event || typeof event !== 'object') throw new Error('Invalid input');
    const { page } = this.get(id, owner);
    const num = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000;
    if (event.kind === 'click' && num(event.x) && num(event.y)) {
      await page.mouse.click(event.x, event.y);
    } else if (event.kind === 'scroll' && num(event.deltaX) && num(event.deltaY)) {
      await page.mouse.wheel(event.deltaX, event.deltaY);
    } else if (event.kind === 'type' && typeof event.text === 'string' && event.text.length <= 4096) {
      await page.keyboard.insertText(event.text);
    } else if (event.kind === 'key' && typeof event.key === 'string' && event.key.length <= 80) {
      await page.keyboard.press(event.key);
    } else { throw new Error('Invalid input event'); }
    return { accepted: true };
  }
  async screenshot(id, owner = null) {
    return this.get(id, owner).page.screenshot({ type: 'png', fullPage: false, timeout: 15000 });
  }
  async stream(id, emit, options = {}) {
    const session = this.get(id, owner);
    if (session.stream || session.streamPending) throw new Error('Stream already active');
    session.streamPending = true;
    // Chromium CDP: event-driven frames, not a fixed-FPS video recording.
    let cdp;
    try { cdp = await session.context.newCDPSession(session.page); }
    catch (error) { session.streamPending = false; throw error; }
    let closed = false;
    const onFrame = frame => {
      if (closed) return;
      try { emit({ mime: 'image/jpeg', data: frame.data, metadata: frame.metadata }); }
      catch { void close(); }
      finally { cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}); }
    };
    cdp.on('Page.screencastFrame', onFrame);
    const close = async () => {
      if (closed) return;
      closed = true;
      cdp.off('Page.screencastFrame', onFrame);
      if (session.stream === close) session.stream = null;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      options.onStop?.();
    };
    session.stream = close;
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: options.quality ?? 65, everyNthFrame: options.everyNthFrame ?? 1
      });
      session.streamPending = false;
      return close;
    } catch (error) { session.streamPending = false; await close(); throw error; }
  }
  close(id, owner = null) {
    const existing = this.inFlightCloses.get(id);
    if (existing) return this.closingOwners.get(id) === owner ? existing : Promise.resolve(false);
    const session = this.sessions.get(id);
    if (!session || (session.owner ?? null) !== owner) return Promise.resolve(false);
    this.sessions.delete(id);
    // A closing context still consumes capacity and pixels until OS resources
    // are actually released. Track it before yielding to asynchronous close.
    this.closingPixels += session.pixels || 0;
    this.closingOwners.set(id, owner);
    const closing = (async () => {
      try {
        try { if (session.stream) await session.stream(); }
        finally { await session.context.close(); }
        return true;
      } finally {
        this.closingPixels -= session.pixels || 0;
        this.inFlightCloses.delete(id);
        this.closingOwners.delete(id);
      }
    })();
    this.inFlightCloses.set(id, closing);
    return closing;
  }
  async prune(now = Date.now()) {
    // Streaming sessions have a hard maximum lifetime to prevent slot exhaustion.
    const expired = [...this.sessions].filter(([, s]) =>
      now - (s.createdAt ?? s.touched) > this.config.maxAgeMs ||
      (!s.stream && !s.streamPending && now - s.touched > this.config.idleMs)
    ).map(([id, s]) => ({ id, owner: s.owner ?? null }));
    await Promise.all(expired.map(({ id, owner }) => this.close(id, owner)));
    return expired.length;
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.stopInternal();
    try { await this.stopPromise; }
    finally { this.stopping = false; this.stopPromise = null; }
  }
  async stopInternal() {
    if (this.startPromise) await this.startPromise.catch(() => {});
    await Promise.allSettled([...this.inFlightCreates]);
    await Promise.allSettled([...this.sessions].map(([id, s]) => this.close(id, s.owner ?? null)));
    await Promise.allSettled([...this.inFlightCloses.values()]);
    // A crashed browser or failed context close must not strand the host-side
    // network bridge or egress proxy after shutdown.
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    if (this.bridge) await this.bridge.stop().catch(() => {});
    this.bridge = null;
    if (this.sandboxRoot) await rmdir(this.sandboxRoot).catch(() => {});
    this.sandboxRoot = null;
    if (this.egress) await this.egress.stop().catch(() => {});
    this.egress = null;
    this.proxyUrl = null;
    this.factory = this.customFactory;
  }
}
