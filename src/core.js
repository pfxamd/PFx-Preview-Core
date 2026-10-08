import { randomUUID } from 'node:crypto';
import { validateTarget } from './security.js';

export class PreviewCore {
  constructor({ browserFactory, validate = validateTarget, config = {} } = {}) {
    this.factory = browserFactory;
    this.validate = validate;
    this.config = { maxSessions: 4, idleMs: 600000, navigationMs: 25000, ...config };
    this.sessions = new Map();
    this.browser = null;
  }
  async start() {
    if (!this.factory) {
      const { chromium } = await import('playwright');
      this.factory = () => chromium.launch({ headless: true });
    }
    this.browser = await this.factory();
    return this;
  }
  async create({ url, width = 1280, height = 800, deviceScaleFactor = 1 } = {}) {
    if (!this.browser) throw new Error('Core not started');
    if (this.sessions.size >= this.config.maxSessions) throw new Error('Session capacity reached');
    for (const [key, value] of Object.entries({ width, height, deviceScaleFactor })) {
      const max = key === 'deviceScaleFactor' ? 3 : 3840;
      const min = key === 'deviceScaleFactor' ? 1 : 240;
      if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + key);
    }
    const safeUrl = await this.validate(url);
    const context = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor, serviceWorkers: 'block', acceptDownloads: false });
    try {
      // Defense in depth only; network-level egress isolation is mandatory for deployment.
      await context.route('**/*', async route => {
        try { await this.validate(route.request().url()); await route.continue(); }
        catch { await route.abort('blockedbyclient'); }
      });
      const page = await context.newPage();
      await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: this.config.navigationMs });
      const id = randomUUID();
      this.sessions.set(id, { context, page, touched: Date.now() });
      return { id, url: page.url(), viewport: page.viewportSize() };
    } catch (error) { await context.close(); throw error; }
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    session.touched = Date.now();
    return session;
  }
  async resize(id, { width, height }) {
    if (![width, height].every(n => Number.isInteger(n) && n >= 240 && n <= 3840)) throw new Error('Invalid viewport');
    const { page } = this.get(id);
    await page.setViewportSize({ width, height });
    return { viewport: page.viewportSize() };
  }
  async screenshot(id) { return this.get(id).page.screenshot({ type: 'png', fullPage: false, timeout: 15000 }); }
  async close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.context.close();
    return true;
  }
  async prune(now = Date.now()) {
    const ids = [...this.sessions].filter(([, s]) => now - s.touched > this.config.idleMs).map(([id]) => id);
    await Promise.all(ids.map(id => this.close(id)));
    return ids.length;
  }
  async stop() {
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
    if (this.browser) await this.browser.close();
    this.browser = null;
  }
}
