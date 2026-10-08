import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
function privateV4(ip) {
  const a = ip.split('.').map(Number);
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && a[1] === 168) ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19)) ||
    (a[0] === 192 && a[1] === 0 && a[2] === 2) ||
    (a[0] === 198 && a[1] === 51 && a[2] === 100) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113);
}
export function isDisallowedIP(address) {
  const ip = address.toLowerCase().split('%')[0];
  if (isIP(ip) === 4) return privateV4(ip);
  if (isIP(ip) !== 6) return true;
  if (ip === '::' || ip === '::1') return true;
  const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('2001:db8:');
}
export async function validateTarget(raw, resolver = lookup) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without embedded credentials are supported');
  const hostname = url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || ['localhost', 'localhost.localdomain', 'metadata.google.internal'].includes(hostname) || ['.localhost', '.local', '.internal'].some(x => hostname.endsWith(x))) throw new Error('Destination is not public');
  if (isIP(hostname)) { if (isDisallowedIP(hostname)) throw new Error('Destination is not public'); }
  else {
    const records = await resolver(hostname, { all: true, verbatim: true });
    if (!records.length || records.some(x => isDisallowedIP(x.address))) throw new Error('Destination resolves to a non-public address');
  }
  return url.toString();
}
