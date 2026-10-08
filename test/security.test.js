import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, isDisallowedIP } from '../src/security.js';
const publicDNS = async () => [{ address: '8.8.8.8' }, { address: '2606:4700:4700::1111' }];

test('rejects invalid protocols, embedded credentials and local hostnames', async () => {
  for (const target of [
    'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'http://user:pass@example.com',
    'http://localhost', 'http://localhost.localdomain', 'http://metadata.google.internal',
    'http://server.internal', 'ftp://example.com', 'http://example.test'
  ]) await assert.rejects(validateTarget(target, publicDNS), undefined, target);
});

test('rejects private, link-local, documentation, reserved, mapped IP addresses', () => {
  for (const ip of [
    '127.0.0.1', '10.4.1.2', '192.168.2.1', '172.16.0.1', '169.254.169.254',
    '100.64.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.7', '192.0.0.10',
    '0.0.0.0', '240.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b:1::1', '::2', '2002:c0a8:0101::'
  ]) assert.equal(isDisallowedIP(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isDisallowedIP(ip), false, ip);
});

test('rejects mixed public and private DNS and failed resolution', async () => {
  await assert.rejects(validateTarget('https://example.com', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]));
  await assert.rejects(validateTarget('https://example.com', async () => []));
  await assert.rejects(validateTarget('https://example.com', async () => { throw new Error('dns failed'); }));
});

test('accepts only explicitly public HTTP(S) destinations', async () => {
  assert.equal(await validateTarget('https://example.com/path', publicDNS), 'https://example.com/path');
  assert.equal(await validateTarget('http://8.8.8.8/', publicDNS), 'http://8.8.8.8/');
});

test('rejects numeric and encoded representations of local IP', async () => {
  for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://[::ffff:7f00:1]/']) {
    await assert.rejects(validateTarget(url, publicDNS), undefined, url);
  }
});
