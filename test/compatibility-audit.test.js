import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCompatibility } from '../src/compatibility-audit.js';

const good = { title: 'MDN Web Docs', finalUrl: 'https://developer.mozilla.org/en-US/', httpStatus: 200 };
test('normal successful HTML navigation is compatible', () => {
  assert.equal(auditCompatibility(good).compatible, true);
  assert.equal(auditCompatibility({ ...good, httpStatus: null }).compatible, true);
});

test('security and access-denied pages do not masquerade as compatibility passes', () => {
  for (const title of ['Just a moment...', 'Just a moment…', 'Attention Required! | Cloudflare',
    'Checking your browser before accessing', 'Verify you are human', 'Access Denied', 'Robot Check']) {
    assert.equal(auditCompatibility({ ...good, title }).compatible, false, title);
  }
});

test('blocked HTTP responses, redirects and challenge DOM are incompatible', () => {
  for (const status of [0, 301, 401, 403, 404, 429, 500]) {
    assert.equal(auditCompatibility({ ...good, httpStatus: status }).compatible, false, `HTTP ${status}`);
  }
  assert.equal(auditCompatibility({ ...good, finalUrl: 'https://challenges.cloudflare.com/turnstile' }).compatible, false);
  assert.equal(auditCompatibility({ ...good, finalUrl: 'https://www.w3.org/cdn-cgi/challenge-platform/' }).compatible, false);
  assert.equal(auditCompatibility({ ...good, challengeMarkers: true }).compatible, false);
  assert.equal(auditCompatibility({ ...good, title: '' }).compatible, false);
  assert.equal(auditCompatibility({ ...good, finalUrl: 'not-a-url' }).compatible, false);
});