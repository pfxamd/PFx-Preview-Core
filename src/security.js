import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// Explicit deny ranges. A dedicated egress firewall is still mandatory for public hosting.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blockedV6.addSubnet(network, prefix, 'ipv6');

export function isDisallowedIP(raw) {
  if (typeof raw !== 'string') return true;
  const address = raw.toLowerCase().split('%')[0];
  const family = isIP(address);
  if (!family) return true;
  return family === 4 ? blockedV4.check(address, 'ipv4') : (!/^[23][0-9a-f]{3}:/i.test(address) || blockedV6.check(address, 'ipv6'));
}

export function assertPublicURL(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Invalid URL');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  }
  const hostname = url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname === 'localhost.localdomain' || hostname === 'metadata.google.internal' ||
      ['.localhost', '.local', '.internal', '.test', '.invalid'].some(suffix => hostname.endsWith(suffix))) {
    throw new Error('Destination is not public');
  }
  if (isIP(hostname) && isDisallowedIP(hostname)) throw new Error('Destination is not public');
  return url;
}

export async function validateTarget(raw, resolver = lookup) {
  const url = assertPublicURL(raw);
  const hostname = url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!isIP(hostname)) {
    let addresses;
    try { addresses = await resolver(hostname, { all: true, verbatim: true }); }
    catch { throw new Error('Destination DNS lookup failed'); }
    if (!addresses.length || addresses.some(entry => isDisallowedIP(entry.address))) {
      throw new Error('Destination resolves to a non-public address');
    }
  }
  return url.toString();
}
