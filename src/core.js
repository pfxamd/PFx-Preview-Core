import { randomUUID } from 'node:crypto';
import { validateTarget } from './security.js';

const limits = { maxSessions: 4, idleMs: 10 * 60_000, navigationMs: 25_000 };
const checkViewport = ({ width, height, deviceScaleFactor = 1 }) => {
  for (const [key, n] of Object.entries({ width, height, deviceScaleFactor })) {
    const min = key === 'deviceScaleFactor' ? 1 : 240;
    const max = key === 'deviceScaleFactor' ? 3 : 3840;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
  }
};

export class PreviewCore {
  constructor({ browserFactory, validate = validateTarget, config = {} } = {}) {
    this.factory = browserFactory;
    this.validate = validate;
    this.config = { ...limits, ...config };
    this.sessions = new Map();
    this.pendingCreates = 0;
    this.browser = null;
  }
  async start() {
    if (this.browser) return this;
    if (!this.factory) {
      const { chromium } = await import('playwright-core');
      this.factory = () => chromium.launch({
        headless: true,
        ...(process.env.PFX_CHROMIUM_PATH ? { executablePath: process.env.PFX_CHROMIUM_PATH } : {})
      });
    }
    this.browser = await this.factory();
    return this;
  }
  async create({ url, width = 1280, height = 800, deviceScaleFactor = 1 } = {}) {
    if (!this.browser) throw new Error('Core not started');
    checkViewport({ width, height, deviceScaleFactor });
    if (this.sessions.size + this.pendingCreates >= this.config.maxSessions) throw new Error('Session capacity reached');
    this.pendingCreates++;
    let context;
    try {
      const target = await this.validate(url);
      context = await this.browser.newContext({
        viewport: { width, height }, deviceScaleFactor, serviceWorkers: 'block', acceptDownloads: false,
        permissions: []
      });
      // Defense in depth only: request routing cannot pin DNS or enforce network isolation.
      await context.route('**/*', async route => {
        try { await this.validate(route.request().url()); await route.continue(); }
        catch { await route.abort('blockedbyclient').catch(() => {}); }
      });
      const page = await context.newPage();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.config.navigationMs });
      const id = randomUUID();
      this.sessions.set(id, { context, page, touched: Date.now(), stream: null });
      return { id, url: page.url(), viewport: page.viewportSize() };
    } catch (error) {
      if (context) await context.close().catch(() => {});
      throw error;
    } finally {
      this.pendingCreates--;
    }
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    session.touched = Date.now();
    return session;
  }
  async resize(id, dimensions) {
    checkViewport({ ...dimensions, deviceScaleFactor: 1 });
    const { page } = this.get(id);
    await page.setViewportSize({ width: dimensions.width, height: dimensions.height });
    return { viewport: page.viewportSize() };
  }
  async navigate(id, url) {
    const safeUrl = await this.validate(url);
    const session = this.get(id);
    await session.page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: this.config.navigationMs });
    return { url: session.page.url() };
  }
  async input(id, event) {
    if (!event || typeof event !== 'object') throw new Error('Invalid input');
    const { page } = this.get(id);
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
  async screenshot(id) {
    return this.get(id).page.screenshot({ type: 'png', fullPage: false, timeout: 15000 });
  }
  async stream(id, emit, options = {}) {
    const session = this.get(id);
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
  async close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    if (session.stream) await session.stream();
    await session.context.close();
    return true;
  }
  async prune(now = Date.now()) {
    const expired = [...this.sessions].filter(([, s]) => now - s.touched > this.config.idleMs).map(([id]) => id);
    await Promise.all(expired.map(id => this.close(id)));
    return expired.length;
  }
  async stop() {
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
    if (this.browser) await this.browser.close();
    this.browser = null;
  }
}
