import { PreviewCore } from '../src/core.js';
import { auditCompatibility } from '../src/compatibility-audit.js';

// Diagnostic compatibility matrix: genuine navigation, title and screenshot;
// never infer that sign-in, DRM or anti-bot challenges are supported.
const sites = [
  'https://example.com/', 'https://www.w3.org/', 'https://developer.mozilla.org/en-US/',
  'https://www.wikipedia.org/', 'https://www.mozilla.org/', 'https://github.com/',
  'https://web.dev/', 'https://react.dev/', 'https://vuejs.org/',
  'https://angular.dev/', 'https://svelte.dev/', 'https://astro.build/',
  'https://nextjs.org/', 'https://www.typescriptlang.org/', 'https://vite.dev/',
  'https://nodejs.org/', 'https://www.python.org/', 'https://www.gnu.org/',
  'https://www.cloudflare.com/', 'https://www.openstreetmap.org/'
];
const timeoutMs = Number(process.env.PFX_COMPAT_TIMEOUT_MS ?? 25_000);
const minimumSuccess = Number(process.env.PFX_COMPAT_MIN_SUCCESS ?? 15);
if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 60000 ||
    !Number.isInteger(minimumSuccess) || minimumSuccess < 1 || minimumSuccess > sites.length) {
  throw new Error('Invalid compatibility policy');
}
const core = new PreviewCore({ config: { navigationMs: timeoutMs } });
const results = [];
try {
  await core.start();
  for (const url of sites) {
    const begin = Date.now();
    let id;
    try {
      const session = await core.create({ url, width: 390, height: 844 });
      id = session.id;
      const page = core.get(id).page;
      const title = await page.title();
      const challengeMarkers = await page.locator('#challenge-form, #cf-challenge-running, .cf-challenge, [data-cf-beacon-challenge]').count() > 0;
      const audit = auditCompatibility({ title, finalUrl: page.url(), httpStatus: session.httpStatus, challengeMarkers });
      if (!audit.compatible) throw new Error(audit.reason);
      const png = await core.screenshot(id);
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid screenshot');
      const status = { status: 'PASS', url, finalUrl: page.url(), httpStatus: session.httpStatus,
        title: title.slice(0, 120), elapsedMs: Date.now() - begin };
      results.push(status);
      console.log(JSON.stringify(status));
    } catch (error) {
      const status = { status: 'FAIL', url, error: String(error.message).slice(0, 250), elapsedMs: Date.now() - begin };
      results.push(status);
      console.log(JSON.stringify(status));
    } finally {
      if (id) await core.close(id).catch(() => {});
    }
  }
} finally {
  await core.stop();
}
const passed = results.filter(r => r.status === 'PASS').length;
const summary = { matrix: 'external-compatibility', total: sites.length, passed, failed: sites.length - passed,
  minimumSuccess, remainingSessions: core.sessions.size, result: passed >= minimumSuccess ? 'PASS' : 'FAIL' };
console.log(JSON.stringify(summary));
if (summary.result !== 'PASS' || core.sessions.size) process.exitCode = 1;
